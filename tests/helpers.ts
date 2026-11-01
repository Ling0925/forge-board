import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect } from "vitest";
import {
  type Actor,
  DEFAULT_WORKSPACE_ID,
  type ErrorCode,
  type Principal,
  type ProjectSettings,
  type Settings,
  errorStatuses,
  scopeSchema,
} from "../src/domain/index.js";
import { createBoard } from "../src/service/index.js";
import { createRepository, openDatabase } from "../src/store/index.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

export function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "forge-board-test-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

export function fixture(
  projectSettings: ProjectSettings = {},
  settings?: Settings,
) {
  let time = Date.parse("2026-11-01T00:00:00.000Z");
  const directory = settings === undefined ? null : temporaryDirectory();
  if (directory !== null)
    writeFileSync(join(directory, "config.json"), JSON.stringify(settings));
  const db = openDatabase(
    directory === null ? ":memory:" : join(directory, "board.sqlite"),
  );
  cleanups.push(() => db.close());
  const repo = createRepository(db);
  const root: Principal = {
    id: "usr_root",
    workspaceId: DEFAULT_WORKSPACE_ID,
    kind: "human",
    name: "Root",
    owner: null,
    disabled: false,
  };
  repo.insert("principals", root);
  const admin: Actor = {
    principal: root,
    scopes: [...scopeSchema.options],
    projectIds: null,
  };
  const board =
    directory === null
      ? createBoard({ db, now: () => time })
      : createBoard({ dataDir: directory, now: () => time });
  cleanups.push(() => board.close());
  const actorOf = (
    principal: Principal,
    scopes: Actor["scopes"] = [
      "tasks:read",
      "tasks:write",
      "tasks:claim",
      "tasks:assign",
      "tasks:approve",
    ],
  ): Actor => ({ principal, scopes, projectIds: null });
  const owner = actorOf(
    board.createPrincipal(admin, { kind: "human", name: "Owner" }),
  );
  const other = actorOf(
    board.createPrincipal(admin, { kind: "human", name: "Other" }),
  );
  const agent = actorOf(
    board.createPrincipal(admin, {
      kind: "agent",
      name: "Worker",
      owner: owner.principal.id,
    }),
  );
  const peer = actorOf(
    board.createPrincipal(admin, {
      kind: "agent",
      name: "Peer",
      owner: owner.principal.id,
    }),
  );
  const foreignAgent = actorOf(
    board.createPrincipal(admin, {
      kind: "agent",
      name: "Foreign",
      owner: other.principal.id,
    }),
  );
  const project = board.createProject(admin, {
    key: "TEST",
    name: "Test",
    settings: projectSettings,
  });
  const task = (title = "Task") =>
    board.createTask(admin, {
      projectId: project.id,
      title,
      accountable: owner.principal.id,
    });
  return {
    board,
    db,
    repo,
    admin,
    owner,
    other,
    agent,
    peer,
    foreignAgent,
    project,
    actorOf,
    task,
    directory,
    now: () => time,
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
  };
}

export function expectCode(action: () => unknown, code: ErrorCode) {
  expect(action).toThrowError(
    expect.objectContaining({ code, status: errorStatuses[code] }),
  );
}
