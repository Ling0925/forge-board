import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";
import type { z } from "zod";
import {
  DEFAULT_WORKSPACE_ID,
  type Event,
  type Task,
  approvalSchema,
  artifactSchema,
  commentSchema,
  dependencySchema,
  eventSchema,
  labelSchema,
  linkSchema,
  principalSchema,
  projectSchema,
  taskSchema,
  tokenSchema,
  workspaceSchema,
} from "../domain/index.js";

const schemas = {
  workspaces: workspaceSchema,
  projects: projectSchema,
  principals: principalSchema,
  tokens: tokenSchema,
  tasks: taskSchema,
  dependencies: dependencySchema,
  links: linkSchema,
  comments: commentSchema,
  artifacts: artifactSchema,
  labels: labelSchema,
  approvals: approvalSchema,
};
type Table = keyof typeof schemas;
type Entities = { [K in Table]: z.output<(typeof schemas)[K]> };
const jsonFields = new Set([
  "settings",
  "scopes",
  "projectIds",
  "lease",
  "metadata",
  "content",
  "data",
]);
const column = (field: string) =>
  field === "from" || field === "to"
    ? `${field}_status`
    : field.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
const field = (name: string) =>
  name === "from_status" || name === "to_status"
    ? name.replace("_status", "")
    : name.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase());

function encode(value: Record<string, unknown>): [string, SQLInputValue][] {
  return Object.entries(value)
    .filter(([key]) => key !== "labels")
    .map(([key, item]) => [
      column(key),
      jsonFields.has(key) && item !== null
        ? JSON.stringify(item)
        : typeof item === "boolean"
          ? Number(item)
          : (item as SQLInputValue),
    ]);
}

function decode(row: Record<string, SQLOutputValue>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      const name = field(key);
      return [
        name,
        jsonFields.has(name) && typeof value === "string"
          ? JSON.parse(value)
          : name === "disabled"
            ? Boolean(value)
            : value,
      ];
    }),
  );
}

export function createRepository(db: DatabaseSync) {
  const workspaceId = DEFAULT_WORKSPACE_ID;

  function parse<K extends Table>(
    table: K,
    row: Record<string, SQLOutputValue>,
  ): Entities[K] {
    const data = decode(row);
    if (table === "tasks") {
      data.labels = db
        .prepare(
          "SELECT label_id FROM task_labels WHERE workspace_id = ? AND task_id = ? ORDER BY label_id",
        )
        .all(workspaceId, row.id as string)
        .map((label) => label.label_id);
    }
    return schemas[table].parse(data) as Entities[K];
  }

  function get<K extends Table>(table: K, id: string): Entities[K] | undefined {
    const row = db
      .prepare(`SELECT * FROM ${table} WHERE workspace_id = ? AND id = ?`)
      .get(workspaceId, id);
    return row ? parse(table, row) : undefined;
  }

  function list<K extends Table>(
    table: K,
    where = "1 = 1",
    params: SQLInputValue[] = [],
    order = "id",
  ): Entities[K][] {
    return db
      .prepare(
        `SELECT * FROM ${table} WHERE workspace_id = ? AND (${where}) ORDER BY ${order}`,
      )
      .all(workspaceId, ...params)
      .map((row) => parse(table, row));
  }

  function writeLabels(task: Task) {
    db.prepare(
      "DELETE FROM task_labels WHERE workspace_id = ? AND task_id = ?",
    ).run(workspaceId, task.id);
    const insert = db.prepare(
      "INSERT INTO task_labels (workspace_id, task_id, label_id) VALUES (?, ?, ?)",
    );
    for (const labelId of task.labels)
      insert.run(workspaceId, task.id, labelId);
  }

  function insert<K extends Table>(table: K, value: Entities[K]): Entities[K] {
    const data = schemas[table].parse(value);
    const entries = encode(data);
    db.prepare(
      `INSERT INTO ${table} (${entries.map(([key]) => key).join(", ")}) VALUES (${entries.map(() => "?").join(", ")})`,
    ).run(...entries.map(([, item]) => item));
    if (table === "tasks") writeLabels(taskSchema.parse(data));
    return value;
  }

  function update<K extends Table>(table: K, value: Entities[K]): Entities[K] {
    const data = schemas[table].parse(value);
    const entries = encode(data).filter(
      ([key]) => key !== "id" && key !== "workspace_id",
    );
    db.prepare(
      `UPDATE ${table} SET ${entries.map(([key]) => `${key} = ?`).join(", ")} WHERE workspace_id = ? AND id = ?`,
    ).run(...entries.map(([, item]) => item), workspaceId, value.id);
    if (table === "tasks") writeLabels(taskSchema.parse(data));
    return value;
  }

  function remove(table: Table, id: string): void {
    db.prepare(`DELETE FROM ${table} WHERE workspace_id = ? AND id = ?`).run(
      workspaceId,
      id,
    );
  }

  function event(value: Omit<Event, "seq">): Event {
    const entries = encode(value);
    const row = db
      .prepare(
        `INSERT INTO events (${entries.map(([key]) => key).join(", ")}) VALUES (${entries.map(() => "?").join(", ")}) RETURNING *`,
      )
      .get(...entries.map(([, item]) => item));
    return eventSchema.parse(decode(row as Record<string, SQLOutputValue>));
  }

  function events(after: number): Event[] {
    return db
      .prepare(
        "SELECT * FROM events WHERE workspace_id = ? AND seq > ? ORDER BY seq",
      )
      .all(workspaceId, after)
      .map((row) => eventSchema.parse(decode(row)));
  }

  function claim(task: Task): boolean {
    const result = db
      .prepare(`UPDATE tasks SET status = ?, assignee = ?, lease = ?, version = ?, updated_at = ?
      WHERE workspace_id = ? AND id = ? AND status = 'todo' AND lease IS NULL AND version = ?`)
      .run(
        task.status,
        task.assignee,
        JSON.stringify(task.lease),
        task.version,
        task.updatedAt,
        workspaceId,
        task.id,
        task.version - 1,
      );
    return result.changes === 1;
  }

  function nextTaskNumber(projectId: string): number {
    const row = db
      .prepare(
        "SELECT COALESCE(MAX(number), 0) + 1 AS number FROM tasks WHERE workspace_id = ? AND project_id = ?",
      )
      .get(workspaceId, projectId);
    return Number(row?.number);
  }

  function hasPath(from: string, to: string): boolean {
    return !!db
      .prepare(`WITH RECURSIVE ancestors(id) AS (
      SELECT depends_on_id FROM dependencies WHERE workspace_id = ? AND task_id = ?
      UNION
      SELECT d.depends_on_id FROM dependencies d JOIN ancestors a ON d.task_id = a.id WHERE d.workspace_id = ?
    ) SELECT id FROM ancestors WHERE id = ?`)
      .get(workspaceId, from, workspaceId, to);
  }

  function dependenciesDone(taskId: string): boolean {
    return !db
      .prepare(`SELECT d.id FROM dependencies d JOIN tasks t ON t.id = d.depends_on_id
      WHERE d.workspace_id = ? AND d.task_id = ? AND t.status <> 'done'`)
      .get(workspaceId, taskId);
  }

  function replay(
    principalId: string,
    key: string,
  ): { requestHash: string; response: string } | undefined {
    const row = db
      .prepare(
        "SELECT request_hash, response FROM idempotency_records WHERE workspace_id = ? AND principal_id = ? AND key = ?",
      )
      .get(workspaceId, principalId, key);
    return row
      ? {
          requestHash: String(row.request_hash),
          response: String(row.response),
        }
      : undefined;
  }

  function remember(
    principalId: string,
    key: string,
    requestHash: string,
    response: unknown,
    at: string,
  ): void {
    db.prepare(
      "INSERT INTO idempotency_records (workspace_id, principal_id, key, request_hash, response, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      workspaceId,
      principalId,
      key,
      requestHash,
      JSON.stringify(response),
      at,
    );
  }

  function prune(before: string): void {
    db.prepare(
      "DELETE FROM idempotency_records WHERE workspace_id = ? AND created_at <= ?",
    ).run(workspaceId, before);
  }

  return {
    get,
    list,
    insert,
    update,
    remove,
    event,
    events,
    claim,
    nextTaskNumber,
    hasPath,
    dependenciesDone,
    replay,
    remember,
    prune,
  };
}
