import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  type Actor,
  type Approval,
  type Artifact,
  BoardError,
  type CreateTask,
  DEFAULT_WORKSPACE_ID,
  type Event,
  type Mutation,
  type Page,
  type PageInput,
  type Principal,
  type ProjectSettings,
  type Scope,
  type Status,
  type Task,
  type TaskQuery,
  type UpdateTask,
  actorSchema,
  approvalDecisionSchema,
  approvalQuerySchema,
  artifactInputSchema,
  assertTransition,
  commentInputSchema,
  createProjectSchema,
  createTaskSchema,
  eventFilterSchema,
  eventQuerySchema,
  isTerminal,
  linkInputSchema,
  mayAssign,
  mayReclaim,
  mutationSchema,
  needsApproval,
  pageSchema,
  principalInputSchema,
  principalSchema,
  scopeSchema,
  settingsSchema,
  taskQuerySchema,
  tokenInputSchema,
  transitionSchema,
  updateProjectSchema,
  updateTaskSchema,
} from "../domain/index.js";
import {
  createRepository,
  initializeDatabase,
  openDatabase,
  transaction,
} from "../store/index.js";
import { newId } from "./ids.js";

type BoardOptions = (
  | { dataDir: string; db?: never }
  | { db: DatabaseSync; dataDir?: never }
) & { now?: () => number };
export type TransitionResult = { task: Task; approval: Approval | null };

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function canonical(value: unknown): string {
  return JSON.stringify(value, (_, item: unknown) => {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return item;
  });
}

export function createBoard(options: BoardOptions) {
  const now = options.now ?? Date.now;
  const workspaceId = DEFAULT_WORKSPACE_ID;
  let settings = settingsSchema.parse({});
  let db: DatabaseSync;
  if (options.dataDir !== undefined) {
    mkdirSync(options.dataDir, { recursive: true });
    const configPath = join(options.dataDir, "config.json");
    if (existsSync(configPath))
      settings = settingsSchema.parse(
        JSON.parse(readFileSync(configPath, "utf8")),
      );
    else writeFileSync(configPath, "{}\n");
    db = openDatabase(join(options.dataDir, "board.sqlite"));
  } else {
    db = options.db;
    initializeDatabase(db);
  }
  const repo = createRepository(db);
  const listeners = new Set<() => void>();
  let pendingEvents = 0;

  function commit<T>(action: () => T): T {
    pendingEvents = 0;
    const result = transaction(db, action);
    if (pendingEvents > 0) for (const listener of listeners) listener();
    return result;
  }

  const at = () => new Date(now()).toISOString();
  const id = (prefix: string) => newId(prefix, now());

  function required<T>(value: T | undefined, entity: string): T {
    if (value === undefined)
      throw new BoardError("not_found", `${entity} not found`);
    return value;
  }

  function principal(principalId: string): Principal {
    return required(repo.get("principals", principalId), "Principal");
  }

  function human(principalId: string): Principal {
    const person = principal(principalId);
    if (person.kind !== "human")
      throw new BoardError("forbidden", "A human principal is required");
    return person;
  }

  function authenticate(input: Actor): Actor {
    const actor = actorSchema.parse(input);
    const current = repo.get("principals", actor.principal.id);
    if (!current || current.disabled)
      throw new BoardError("unauthorized", "Principal is disabled or unknown");
    if (actor.tokenId !== undefined) {
      const token = repo.get("tokens", actor.tokenId);
      if (
        !token ||
        token.principalId !== current.id ||
        token.revokedAt !== null ||
        (token.expiresAt !== null && Date.parse(token.expiresAt) <= now())
      ) {
        throw new BoardError(
          "unauthorized",
          "Token is invalid, revoked, or expired",
        );
      }
      return {
        principal: current,
        scopes: token.scopes,
        projectIds: token.projectIds,
        tokenId: token.id,
      };
    }
    return { ...actor, principal: current };
  }

  function authorize(actor: Actor, scope: Scope, projectId?: string): void {
    if (!actor.scopes.includes(scope))
      throw new BoardError("forbidden", `Missing scope ${scope}`);
    if (
      projectId !== undefined &&
      actor.projectIds !== null &&
      !actor.projectIds.includes(projectId)
    ) {
      throw new BoardError("forbidden", "Token does not cover this project");
    }
  }

  function globalAccess(actor: Actor): void {
    if (actor.projectIds !== null)
      throw new BoardError(
        "forbidden",
        "An unrestricted project scope is required",
      );
  }

  function visible(actor: Actor, projectId: string | null): boolean {
    return (
      actor.projectIds === null ||
      (projectId !== null && actor.projectIds.includes(projectId))
    );
  }

  function tokenScope(actor: Actor, projectIds: string[] | null): void {
    if (
      actor.projectIds !== null &&
      (projectIds === null ||
        projectIds.some((projectId) => !visible(actor, projectId)))
    ) {
      throw new BoardError(
        "forbidden",
        "Token project scope exceeds the issuer's scope",
      );
    }
  }

  function taskFor(actor: Actor, taskId: string, scope: Scope): Task {
    const task = required(repo.get("tasks", taskId), "Task");
    authorize(actor, scope, task.projectId);
    return task;
  }

  function record(
    actor: Actor,
    type: string,
    data: Event["data"],
    task?: Task,
    projectId?: string,
  ): void {
    repo.event({
      workspaceId,
      type,
      actor: actor.principal.id,
      owner: actor.principal.owner,
      projectId: task?.projectId ?? projectId ?? null,
      taskId: task?.id ?? null,
      data,
      at: at(),
    });
    pendingEvents++;
  }

  function expired(actor: Actor, task: Task): Task {
    if (
      task.lease?.expiresAt === null ||
      task.lease === null ||
      task.lease.expiresAt > at()
    )
      return task;
    const previous = task.lease;
    const updated = {
      ...task,
      status: "todo" as const,
      lease: null,
      version: task.version + 1,
      updatedAt: at(),
    };
    repo.update("tasks", updated);
    record(actor, "lease_expired", { holder: previous.holder }, updated);
    return updated;
  }

  function write<T>(
    inputActor: Actor,
    scope: Scope,
    operation: string,
    request: unknown,
    input: Mutation,
    action: (actor: Actor, mutation: Mutation) => T,
    context: {
      taskIds?: string[];
      access?: (actor: Actor) => void;
      redactReplay?: (response: T) => unknown;
    } = {},
  ): T {
    const mutation = mutationSchema.parse(input);
    const result = commit(() => {
      const actor = authenticate(inputActor);
      authorize(actor, scope);
      context.access?.(actor);
      for (const taskId of context.taskIds ?? []) taskFor(actor, taskId, scope);
      if (settings.idempotencyRetention !== undefined)
        repo.prune(
          new Date(now() - settings.idempotencyRetention).toISOString(),
        );
      const requestHash = hash(
        canonical({
          operation,
          request,
          expectedVersion: mutation.expectedVersion,
          leaseToken: mutation.leaseToken,
        }),
      );
      if (mutation.idempotencyKey !== undefined) {
        const previous = repo.replay(
          actor.principal.id,
          mutation.idempotencyKey,
        );
        if (previous) {
          if (previous.requestHash !== requestHash)
            throw new BoardError(
              "idempotency_mismatch",
              "Idempotency key was used for a different request",
            );
          return {
            ok: true as const,
            value: JSON.parse(previous.response) as T,
          };
        }
      }
      for (const taskId of context.taskIds ?? [])
        expired(actor, taskFor(actor, taskId, scope));
      const beforeMutation = pendingEvents;
      db.exec("SAVEPOINT mutation");
      try {
        const value = action(actor, mutation);
        if (mutation.idempotencyKey !== undefined)
          repo.remember(
            actor.principal.id,
            mutation.idempotencyKey,
            requestHash,
            context.redactReplay ? context.redactReplay(value) : value,
            at(),
          );
        db.exec("RELEASE mutation");
        return { ok: true as const, value };
      } catch (error) {
        db.exec("ROLLBACK TO mutation; RELEASE mutation");
        pendingEvents = beforeMutation;
        return { ok: false as const, error };
      }
    });
    if (!result.ok) throw result.error;
    return result.value;
  }

  function read<T>(
    inputActor: Actor,
    scope: Scope,
    action: (actor: Actor) => T,
  ): T {
    return commit(() => {
      const actor = authenticate(inputActor);
      authorize(actor, scope);
      return action(actor);
    });
  }

  function paginate<T>(
    items: T[],
    input: PageInput,
    key: (item: T) => string,
    after: (item: T, cursor: string) => boolean = (item, cursor) =>
      key(item) > cursor,
  ): Page<T> {
    const page = pageSchema.strip().parse(input);
    const limit =
      settings.maxPageSize === undefined
        ? page.limit
        : Math.min(page.limit, settings.maxPageSize);
    const cursor = page.cursor;
    const remaining =
      cursor === undefined
        ? items
        : items.filter((item) => after(item, cursor));
    const selected = remaining.slice(0, limit);
    const last = selected.at(-1);
    return {
      items: selected,
      nextCursor:
        limit < remaining.length && last !== undefined ? key(last) : null,
    };
  }

  function projectSettings(projectId: string): ProjectSettings {
    return required(repo.get("projects", projectId), "Project").settings;
  }

  function leaseCheck(actor: Actor, task: Task, mutation: Mutation): boolean {
    if (
      mutation.leaseToken !== undefined &&
      (task.lease?.token !== mutation.leaseToken ||
        task.lease.holder !== actor.principal.id)
    ) {
      throw new BoardError(
        "lease_lost",
        "Lease is no longer held by this principal",
        { currentTask: task },
      );
    }
    const holder = task.lease?.holder === actor.principal.id;
    if (holder && mutation.leaseToken === undefined)
      throw new BoardError(
        "lease_lost",
        "The current lease token is required",
        { currentTask: task },
      );
    return holder;
  }

  function checkWrite(
    actor: Actor,
    task: Task,
    mutation: Mutation,
    holderMayOmitVersion = false,
  ): void {
    const holder = leaseCheck(actor, task, mutation);
    if (
      mutation.expectedVersion !== task.version &&
      !(
        mutation.expectedVersion === undefined &&
        holder &&
        holderMayOmitVersion
      )
    ) {
      throw new BoardError("version_mismatch", "Task version does not match", {
        currentTask: task,
      });
    }
  }

  function saveTask(
    actor: Actor,
    task: Task,
    type: string,
    data: Event["data"] = {},
  ): Task {
    const ttl = projectSettings(task.projectId).leaseTtl;
    const lease =
      task.lease?.holder === actor.principal.id
        ? {
            ...task.lease,
            expiresAt:
              ttl === undefined ? null : new Date(now() + ttl).toISOString(),
          }
        : task.lease;
    const updated = repo.update("tasks", {
      ...task,
      lease,
      version: task.version + 1,
      updatedAt: at(),
    });
    record(actor, type, data, updated);
    return updated;
  }

  function assignment(
    actor: Actor,
    projectId: string,
    targetId: string | null,
  ): void {
    authorize(actor, "tasks:assign", projectId);
    const target = targetId === null ? null : principal(targetId);
    if (!mayAssign(actor.principal, target, projectSettings(projectId)))
      throw new BoardError("forbidden", "This assignment is not permitted");
  }

  function validateParent(
    actor: Actor,
    taskId: string | null,
    parentId: string | null,
  ): void {
    let current = parentId;
    while (current !== null) {
      if (current === taskId)
        throw new BoardError("cycle", "Subtask parents must not form a cycle");
      current = taskFor(actor, current, "tasks:read").parentId;
    }
  }

  function validateLabels(projectId: string, labels: string[]): void {
    for (const labelId of labels) {
      const label = required(repo.get("labels", labelId), "Label");
      if (label.projectId !== projectId)
        throw new BoardError(
          "conflict",
          "Label belongs to a different project",
        );
    }
  }

  function applyTransition(
    actor: Actor,
    task: Task,
    to: Status,
    message: string,
  ): Task {
    return saveTask(
      actor,
      {
        ...task,
        status: to,
        statusMessage: message,
        lease: isTerminal(to) || to === "todo" ? null : task.lease,
      },
      "task_transitioned",
      { from: task.status, to },
    );
  }

  function transitionTask(
    actor: Actor,
    task: Task,
    to: Status,
    message: string,
    action: Approval["action"] = "transition",
  ): TransitionResult {
    assertTransition(task.status, to);
    if (needsApproval(projectSettings(task.projectId), task.status, to)) {
      const updated = saveTask(actor, task, "approval_requested", {
        from: task.status,
        to,
      });
      const approval = repo.insert("approvals", {
        id: id("apr"),
        workspaceId,
        taskId: task.id,
        action,
        from: task.status,
        to,
        message,
        taskVersion: updated.version,
        requestedBy: actor.principal.id,
        state: "pending",
        decidedBy: null,
        createdAt: at(),
        decidedAt: null,
      });
      return { task: updated, approval };
    }
    if (to === "canceled" && actor.principal.kind !== "human")
      throw new BoardError("forbidden", "Only a human may cancel a task");
    return { task: applyTransition(actor, task, to, message), approval: null };
  }

  function queryTasks(actor: Actor, query: TaskQuery): Task[] {
    if (query.projectId !== undefined)
      authorize(actor, "tasks:read", query.projectId);
    return repo
      .list("tasks")
      .filter(
        (task) =>
          visible(actor, task.projectId) &&
          (query.projectId === undefined || task.projectId === query.projectId),
      )
      .map((task) => expired(actor, task))
      .filter(
        (task) =>
          (query.status === undefined || task.status === query.status) &&
          (query.assignee === undefined || task.assignee === query.assignee) &&
          (query.parentId === undefined || task.parentId === query.parentId) &&
          (query.label === undefined || task.labels.includes(query.label)) &&
          (query.link === undefined ||
            repo.list("links", "task_id = ? AND ref = ?", [task.id, query.link])
              .length > 0) &&
          (!query.ready ||
            (task.status === "todo" &&
              task.lease === null &&
              repo.dependenciesDone(task.id))),
      )
      .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  }

  function claimTask(
    actor: Actor,
    task: Task,
    mutation: Mutation,
    approvedHolder?: string,
  ): TransitionResult {
    if (mutation.leaseToken !== undefined) leaseCheck(actor, task, mutation);
    if (
      mutation.expectedVersion !== undefined &&
      mutation.expectedVersion !== task.version
    ) {
      throw new BoardError("version_mismatch", "Task version does not match", {
        currentTask: task,
      });
    }
    if (
      task.status !== "todo" ||
      task.lease !== null ||
      !repo.dependenciesDone(task.id)
    ) {
      throw new BoardError("claim_conflict", "Task cannot be claimed", {
        holder: task.lease?.holder ?? null,
        currentTask: task,
      });
    }
    if (
      approvedHolder === undefined &&
      needsApproval(projectSettings(task.projectId), task.status, "in_progress")
    )
      return transitionTask(actor, task, "in_progress", "", "claim");
    const holder = approvedHolder ?? actor.principal.id;
    const ttl = projectSettings(task.projectId).leaseTtl;
    const updated: Task = {
      ...task,
      status: "in_progress",
      assignee: holder,
      lease: {
        holder,
        token: `lse_${randomUUID()}`,
        expiresAt:
          ttl === undefined ? null : new Date(now() + ttl).toISOString(),
      },
      version: task.version + 1,
      updatedAt: at(),
    };
    if (!repo.claim(updated)) {
      const current = required(repo.get("tasks", task.id), "Task");
      throw new BoardError("claim_conflict", "Task cannot be claimed", {
        holder: current.lease?.holder ?? null,
        currentTask: current,
      });
    }
    record(actor, "task_claimed", { holder }, updated);
    return { task: updated, approval: null };
  }

  function eventsFor(
    actor: Actor,
    query: z.infer<typeof eventFilterSchema>,
  ): Event[] {
    if (query.projectId !== undefined)
      authorize(actor, "tasks:read", query.projectId);
    if (query.taskId !== undefined) taskFor(actor, query.taskId, "tasks:read");
    return repo
      .events(query.after ?? 0)
      .filter(
        (event) =>
          visible(actor, event.projectId) &&
          (query.projectId === undefined ||
            event.projectId === query.projectId) &&
          (query.taskId === undefined || event.taskId === query.taskId),
      );
  }

  function issueToken(actor: Actor, data: z.infer<typeof tokenInputSchema>) {
    principal(data.principalId);
    const projectIds = data.projectIds ?? null;
    for (const projectId of projectIds ?? [])
      required(repo.get("projects", projectId), "Project");
    const secret = `fbt_${randomBytes(32).toString("base64url")}`;
    const token = repo.insert("tokens", {
      id: id("tok"),
      workspaceId,
      principalId: data.principalId,
      hash: hash(secret),
      scopes: data.scopes,
      projectIds,
      createdAt: at(),
      expiresAt: data.expiresAt ?? null,
      lastUsedAt: null,
      revokedAt: null,
    });
    record(actor, "token_created", { tokenId: token.id });
    const { hash: _, ...metadata } = token;
    return { token: metadata, secret: secret as string | null };
  }

  return {
    settings,

    initialize(name: string) {
      z.string().parse(name);
      return commit(() => {
        if (repo.list("principals").length > 0)
          throw new BoardError(
            "conflict",
            "Data directory is already initialized",
          );
        const person = repo.insert("principals", {
          id: id("usr"),
          workspaceId,
          kind: "human",
          name,
          owner: null,
          disabled: false,
        });
        const actor: Actor = {
          principal: person,
          scopes: [...scopeSchema.options],
          projectIds: null,
        };
        record(actor, "principal_created", { principalId: person.id });
        const token = issueToken(actor, {
          principalId: person.id,
          scopes: actor.scopes,
        });
        return {
          workspace: required(repo.get("workspaces", workspaceId), "Workspace"),
          principal: person,
          ...token,
        };
      });
    },

    onCommit(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    replayEvents(actor: Actor, input: z.infer<typeof eventFilterSchema>) {
      const query = eventFilterSchema.parse(input);
      return read(actor, "tasks:read", (actor) => eventsFor(actor, query));
    },

    queryApprovals(actor: Actor, input: z.infer<typeof approvalQuerySchema>) {
      const query = approvalQuerySchema.parse(input);
      return read(actor, "tasks:read", (actor) => {
        if (query.projectId !== undefined)
          authorize(actor, "tasks:read", query.projectId);
        if (query.taskId !== undefined)
          expired(actor, taskFor(actor, query.taskId, "tasks:read"));
        const approvals = repo.list("approvals").filter((approval) => {
          const task = required(repo.get("tasks", approval.taskId), "Task");
          return (
            visible(actor, task.projectId) &&
            (query.projectId === undefined ||
              task.projectId === query.projectId) &&
            (query.taskId === undefined || task.id === query.taskId) &&
            (query.state === undefined || approval.state === query.state)
          );
        });
        return paginate(approvals, query, (item) => item.id);
      });
    },

    close() {
      if (options.dataDir !== undefined) db.close();
    },

    getWorkspace(actor: Actor) {
      return read(actor, "tasks:read", () =>
        required(repo.get("workspaces", workspaceId), "Workspace"),
      );
    },

    createPrincipal(
      actor: Actor,
      input: z.input<typeof principalInputSchema>,
      mutation: Mutation = {},
    ) {
      const data = principalInputSchema.parse(input);
      return write(
        actor,
        "tokens:admin",
        "createPrincipal",
        data,
        mutation,
        (actor) => {
          if (data.kind === "agent") human(data.owner);
          const result = repo.insert(
            "principals",
            principalSchema.parse({
              ...data,
              id: id(data.kind === "human" ? "usr" : "agt"),
              workspaceId,
              owner: data.kind === "agent" ? data.owner : null,
              disabled: false,
            }),
          );
          record(actor, "principal_created", { principalId: result.id });
          return result;
        },
        { access: globalAccess },
      );
    },

    listPrincipals(actor: Actor, page: PageInput) {
      return read(actor, "tokens:admin", (actor) => {
        globalAccess(actor);
        return paginate(repo.list("principals"), page, (item) => item.id);
      });
    },

    disablePrincipal(
      actor: Actor,
      principalId: string,
      mutation: Mutation = {},
    ) {
      return write(
        actor,
        "tokens:admin",
        "disablePrincipal",
        { principalId },
        mutation,
        (actor) => {
          const result = repo.update("principals", {
            ...principal(principalId),
            disabled: true,
          });
          record(actor, "principal_disabled", { principalId });
          return result;
        },
        { access: globalAccess },
      );
    },

    createToken(
      actor: Actor,
      input: z.input<typeof tokenInputSchema>,
      mutation: Mutation = {},
    ) {
      const data = tokenInputSchema.parse(input);
      return write(
        actor,
        "tokens:admin",
        "createToken",
        data,
        mutation,
        (actor) => issueToken(actor, data),
        {
          access: (actor) => tokenScope(actor, data.projectIds ?? null),
          redactReplay: (result) => ({ ...result, secret: null }),
        },
      );
    },

    verifyToken(secret: string): Actor {
      return commit(() => {
        const token = repo.list("tokens", "hash = ?", [hash(secret)])[0];
        if (
          !token ||
          token.revokedAt !== null ||
          (token.expiresAt !== null && Date.parse(token.expiresAt) <= now())
        )
          throw new BoardError(
            "unauthorized",
            "Token is invalid, revoked, or expired",
          );
        const actor = authenticate({
          principal: principal(token.principalId),
          scopes: token.scopes,
          projectIds: token.projectIds,
          tokenId: token.id,
        });
        repo.update("tokens", { ...token, lastUsedAt: at() });
        record(actor, "token_used", { tokenId: token.id });
        return actor;
      });
    },

    listTokens(actor: Actor, page: PageInput) {
      return read(actor, "tokens:admin", (actor) =>
        paginate(
          repo
            .list("tokens")
            .filter(
              (token) =>
                actor.projectIds === null ||
                token.projectIds?.every((projectId) =>
                  visible(actor, projectId),
                ),
            )
            .map(({ hash: _, ...token }) => token),
          page,
          (token) => token.id,
        ),
      );
    },

    revokeToken(actor: Actor, tokenId: string, mutation: Mutation = {}) {
      return write(
        actor,
        "tokens:admin",
        "revokeToken",
        { tokenId },
        mutation,
        (actor) => {
          const token = required(repo.get("tokens", tokenId), "Token");
          const { hash: _, ...result } = repo.update("tokens", {
            ...token,
            revokedAt: at(),
          });
          record(actor, "token_revoked", { tokenId });
          return result;
        },
        {
          access: (actor) =>
            tokenScope(
              actor,
              required(repo.get("tokens", tokenId), "Token").projectIds,
            ),
        },
      );
    },

    createProject(
      actor: Actor,
      input: z.input<typeof createProjectSchema>,
      mutation: Mutation = {},
    ) {
      const data = createProjectSchema.parse(input);
      return write(
        actor,
        "projects:admin",
        "createProject",
        data,
        mutation,
        (actor) => {
          if (repo.list("projects", "key = ?", [data.key]).length)
            throw new BoardError("conflict", "Project key already exists");
          const result = repo.insert("projects", {
            ...data,
            settings: data.settings ?? {},
            id: id("prj"),
            workspaceId,
          });
          record(
            actor,
            "project_created",
            { projectId: result.id },
            undefined,
            result.id,
          );
          return result;
        },
        { access: globalAccess },
      );
    },

    updateProject(
      actor: Actor,
      projectId: string,
      input: { name?: string; settings?: ProjectSettings },
      mutation: Mutation = {},
    ) {
      const data = updateProjectSchema.parse(input);
      return write(
        actor,
        "projects:admin",
        "updateProject",
        { projectId, data },
        mutation,
        (actor) => {
          const result = repo.update("projects", {
            ...required(repo.get("projects", projectId), "Project"),
            ...data,
          });
          record(actor, "project_updated", { projectId }, undefined, projectId);
          return result;
        },
        { access: (actor) => authorize(actor, "projects:admin", projectId) },
      );
    },

    getProject(actor: Actor, projectId: string) {
      return read(actor, "tasks:read", (actor) => {
        authorize(actor, "tasks:read", projectId);
        return required(repo.get("projects", projectId), "Project");
      });
    },

    listProjects(actor: Actor, page: PageInput) {
      return read(actor, "tasks:read", (actor) =>
        paginate(
          repo.list("projects").filter((project) => visible(actor, project.id)),
          page,
          (project) => project.id,
        ),
      );
    },

    createTask(actor: Actor, input: CreateTask, mutation: Mutation = {}): Task {
      const data = createTaskSchema.parse(input);
      return write(
        actor,
        "tasks:write",
        "createTask",
        data,
        mutation,
        (actor) => {
          projectSettings(data.projectId);
          human(data.accountable);
          if (data.assignee !== undefined && data.assignee !== null)
            assignment(actor, data.projectId, data.assignee);
          validateParent(actor, null, data.parentId ?? null);
          validateLabels(data.projectId, data.labels ?? []);
          const result = repo.insert("tasks", {
            id: id("tsk"),
            workspaceId,
            projectId: data.projectId,
            number: repo.nextTaskNumber(data.projectId),
            title: data.title,
            description: data.description ?? "",
            status: "todo",
            statusMessage: "",
            accountable: data.accountable,
            assignee: data.assignee ?? null,
            lease: null,
            parentId: data.parentId ?? null,
            priority: data.priority ?? 0,
            labels: [...new Set(data.labels ?? [])].sort(),
            authorization: data.authorization ?? null,
            progress: "",
            metadata: data.metadata ?? {},
            version: 1,
            createdBy: actor.principal.id,
            createdAt: at(),
            updatedAt: at(),
          });
          record(actor, "task_created", { taskId: result.id }, result);
          return result;
        },
        { access: (actor) => authorize(actor, "tasks:write", data.projectId) },
      );
    },

    getTask(actor: Actor, taskId: string): Task {
      return read(actor, "tasks:read", (actor) =>
        expired(actor, taskFor(actor, taskId, "tasks:read")),
      );
    },

    listTasks(actor: Actor, input: TaskQuery): Page<Task> {
      const query = taskQuerySchema.parse(input);
      return read(actor, "tasks:read", (actor) =>
        paginate(
          queryTasks(actor, query),
          query,
          (task) => JSON.stringify([task.priority, task.id]),
          (task, cursor) => {
            const [priority, id] = z
              .tuple([z.number(), z.string()])
              .parse(JSON.parse(cursor));
            return (
              task.priority < priority ||
              (task.priority === priority && task.id > id)
            );
          },
        ),
      );
    },

    updateTask(
      actor: Actor,
      taskId: string,
      input: UpdateTask,
      mutation: Mutation = {},
    ): Task {
      const data = updateTaskSchema.parse(input);
      return write(
        actor,
        "tasks:write",
        "updateTask",
        { taskId, data },
        mutation,
        (actor, mutation) => {
          const task = taskFor(actor, taskId, "tasks:write");
          checkWrite(
            actor,
            task,
            mutation,
            Object.keys(data).every(
              (key) => key === "progress" || key === "statusMessage",
            ),
          );
          if (data.accountable !== undefined) human(data.accountable);
          if (data.assignee !== undefined)
            assignment(actor, task.projectId, data.assignee);
          if (data.parentId !== undefined)
            validateParent(actor, task.id, data.parentId);
          return saveTask(actor, { ...task, ...data }, "task_updated", {
            fields: Object.keys(data),
          });
        },
        { taskIds: [taskId] },
      );
    },

    claim(
      actor: Actor,
      taskId: string,
      mutation: Mutation = {},
    ): TransitionResult {
      return write(
        actor,
        "tasks:claim",
        "claim",
        { taskId },
        mutation,
        (actor, mutation) =>
          claimTask(actor, taskFor(actor, taskId, "tasks:claim"), mutation),
        { taskIds: [taskId] },
      );
    },

    claimNext(
      actor: Actor,
      projectId: string,
      mutation: Mutation = {},
    ): TransitionResult | null {
      return write(
        actor,
        "tasks:claim",
        "claimNext",
        { projectId },
        mutation,
        (actor, mutation) => {
          projectSettings(projectId);
          const candidates = repo
            .list("tasks", "project_id = ?", [projectId])
            .map((task) => expired(actor, task))
            .filter(
              (task) =>
                task.status === "todo" &&
                task.lease === null &&
                repo.dependenciesDone(task.id),
            )
            .sort(
              (a, b) => b.priority - a.priority || a.id.localeCompare(b.id),
            );
          const task = candidates[0];
          return task === undefined ? null : claimTask(actor, task, mutation);
        },
        { access: (actor) => authorize(actor, "tasks:claim", projectId) },
      );
    },

    renewLease(actor: Actor, taskId: string, mutation: Mutation): Task {
      return write(
        actor,
        "tasks:claim",
        "renewLease",
        { taskId },
        mutation,
        (actor, mutation) => {
          const task = taskFor(actor, taskId, "tasks:claim");
          if (!leaseCheck(actor, task, mutation))
            throw new BoardError(
              "lease_lost",
              "Lease is no longer held by this principal",
              { currentTask: task },
            );
          if (mutation.expectedVersion !== undefined)
            checkWrite(actor, task, mutation);
          return saveTask(actor, task, "lease_renewed");
        },
        { taskIds: [taskId] },
      );
    },

    release(
      actor: Actor,
      taskId: string,
      mutation: Mutation,
    ): TransitionResult {
      return write(
        actor,
        "tasks:claim",
        "release",
        { taskId },
        mutation,
        (actor, mutation) => {
          const task = taskFor(actor, taskId, "tasks:claim");
          if (!leaseCheck(actor, task, mutation))
            throw new BoardError(
              "lease_lost",
              "Lease is no longer held by this principal",
              { currentTask: task },
            );
          if (mutation.expectedVersion !== undefined)
            checkWrite(actor, task, mutation);
          return transitionTask(actor, task, "todo", "");
        },
        { taskIds: [taskId] },
      );
    },

    reclaim(
      actor: Actor,
      taskId: string,
      mutation: Mutation,
    ): TransitionResult {
      const scope = actor.scopes.includes("projects:admin")
        ? "projects:admin"
        : "tasks:claim";
      return write(
        actor,
        scope,
        "reclaim",
        { taskId },
        mutation,
        (actor, mutation) => {
          const task = taskFor(actor, taskId, scope);
          if (mutation.leaseToken !== undefined)
            leaseCheck(actor, task, mutation);
          if (!task.lease)
            throw new BoardError("conflict", "Task has no active lease");
          if (
            !mayReclaim(
              actor.principal,
              task,
              principal(task.lease.holder),
              actor.scopes.includes("projects:admin"),
            )
          )
            throw new BoardError(
              "forbidden",
              "Only the accountable human, holder's owner, or a project administrator may reclaim",
            );
          if (mutation.expectedVersion !== task.version)
            throw new BoardError(
              "version_mismatch",
              "Task version does not match",
              { currentTask: task },
            );
          return transitionTask(actor, task, "todo", "");
        },
        { taskIds: [taskId] },
      );
    },

    transition(
      actor: Actor,
      taskId: string,
      input: z.input<typeof transitionSchema>,
      mutation: Mutation = {},
    ): TransitionResult {
      const data = transitionSchema.parse(input);
      return write(
        actor,
        "tasks:write",
        "transition",
        { taskId, data },
        mutation,
        (actor, mutation) => {
          const task = taskFor(actor, taskId, "tasks:write");
          checkWrite(actor, task, mutation, true);
          return transitionTask(actor, task, data.to, data.message ?? "");
        },
        { taskIds: [taskId] },
      );
    },

    decideApproval(
      actor: Actor,
      approvalId: string,
      decision: "approved" | "rejected",
      mutation: Mutation = {},
    ): TransitionResult {
      approvalDecisionSchema.parse(decision);
      const approval = required(repo.get("approvals", approvalId), "Approval");
      return write(
        actor,
        "tasks:approve",
        "decideApproval",
        { approvalId, decision },
        mutation,
        (actor, mutation) => {
          if (actor.principal.kind !== "human")
            throw new BoardError(
              "forbidden",
              "Only humans may decide approvals",
            );
          const current = required(
            repo.get("approvals", approvalId),
            "Approval",
          );
          const task = taskFor(actor, current.taskId, "tasks:approve");
          leaseCheck(actor, task, mutation);
          if (current.state !== "pending")
            throw new BoardError("conflict", "Approval is already decided");
          if (
            mutation.expectedVersion !== task.version ||
            (decision === "approved" && current.taskVersion !== task.version)
          )
            throw new BoardError(
              "version_mismatch",
              "Task version does not match",
              { currentTask: task },
            );
          let updated = task;
          if (decision === "approved") {
            assertTransition(task.status, current.to);
            updated =
              current.action === "claim"
                ? claimTask(actor, task, mutation, current.requestedBy).task
                : applyTransition(actor, task, current.to, current.message);
          } else
            updated = saveTask(actor, task, "approval_rejected", {
              approvalId,
            });
          const decided = repo.update("approvals", {
            ...current,
            state: decision,
            decidedBy: actor.principal.id,
            decidedAt: at(),
          });
          if (decision === "approved")
            record(actor, "approval_approved", { approvalId }, updated);
          return { task: updated, approval: decided };
        },
        { taskIds: [approval.taskId] },
      );
    },

    listApprovals(actor: Actor, taskId: string, page: PageInput) {
      return read(actor, "tasks:read", (actor) => {
        expired(actor, taskFor(actor, taskId, "tasks:read"));
        return paginate(
          repo.list("approvals", "task_id = ?", [taskId]),
          page,
          (item) => item.id,
        );
      });
    },

    addDependency(
      actor: Actor,
      taskId: string,
      dependsOnId: string,
      mutation: Mutation,
    ) {
      return write(
        actor,
        "tasks:write",
        "addDependency",
        { taskId, dependsOnId },
        mutation,
        (actor, mutation) => {
          const task = taskFor(actor, taskId, "tasks:write");
          taskFor(actor, dependsOnId, "tasks:read");
          checkWrite(actor, task, mutation);
          if (taskId === dependsOnId || repo.hasPath(dependsOnId, taskId))
            throw new BoardError("cycle", "Dependency would create a cycle");
          if (
            repo.list("dependencies", "task_id = ? AND depends_on_id = ?", [
              taskId,
              dependsOnId,
            ]).length
          )
            throw new BoardError("conflict", "Dependency already exists");
          const dependency = repo.insert("dependencies", {
            id: id("dep"),
            workspaceId,
            taskId,
            dependsOnId,
          });
          return {
            dependency,
            task: saveTask(actor, task, "dependency_added", { dependsOnId }),
          };
        },
        { taskIds: [taskId] },
      );
    },

    removeDependency(
      actor: Actor,
      taskId: string,
      dependencyId: string,
      mutation: Mutation,
    ) {
      return write(
        actor,
        "tasks:write",
        "removeDependency",
        { taskId, dependencyId },
        mutation,
        (actor, mutation) => {
          const task = taskFor(actor, taskId, "tasks:write");
          checkWrite(actor, task, mutation);
          const dependency = required(
            repo.get("dependencies", dependencyId),
            "Dependency",
          );
          if (dependency.taskId !== taskId)
            throw new BoardError("not_found", "Dependency not found on task");
          repo.remove("dependencies", dependencyId);
          return saveTask(actor, task, "dependency_removed", {
            dependsOnId: dependency.dependsOnId,
          });
        },
        { taskIds: [taskId] },
      );
    },

    listDependencies(actor: Actor, taskId: string, page: PageInput) {
      return read(actor, "tasks:read", (actor) => {
        expired(actor, taskFor(actor, taskId, "tasks:read"));
        return paginate(
          repo.list("dependencies", "task_id = ?", [taskId]),
          page,
          (item) => item.id,
        );
      });
    },

    addLink(
      actor: Actor,
      taskId: string,
      input: z.input<typeof linkInputSchema>,
      mutation: Mutation,
    ) {
      const data = linkInputSchema.parse(input);
      return write(
        actor,
        "tasks:write",
        "addLink",
        { taskId, data },
        mutation,
        (actor, mutation) => {
          const task = taskFor(actor, taskId, "tasks:write");
          checkWrite(actor, task, mutation);
          if (
            repo.list("links", "task_id = ? AND kind = ? AND ref = ?", [
              taskId,
              data.kind,
              data.ref,
            ]).length
          )
            throw new BoardError("conflict", "Link already exists");
          const link = repo.insert("links", {
            ...data,
            title: data.title ?? null,
            id: id("lnk"),
            workspaceId,
            taskId,
          });
          return {
            link,
            task: saveTask(actor, task, "link_added", { linkId: link.id }),
          };
        },
        { taskIds: [taskId] },
      );
    },

    removeLink(
      actor: Actor,
      taskId: string,
      linkId: string,
      mutation: Mutation,
    ) {
      return write(
        actor,
        "tasks:write",
        "removeLink",
        { taskId, linkId },
        mutation,
        (actor, mutation) => {
          const task = taskFor(actor, taskId, "tasks:write");
          checkWrite(actor, task, mutation);
          const link = required(repo.get("links", linkId), "Link");
          if (link.taskId !== taskId)
            throw new BoardError("not_found", "Link not found on task");
          repo.remove("links", linkId);
          return saveTask(actor, task, "link_removed", { linkId });
        },
        { taskIds: [taskId] },
      );
    },

    listLinks(actor: Actor, taskId: string, page: PageInput) {
      return read(actor, "tasks:read", (actor) => {
        expired(actor, taskFor(actor, taskId, "tasks:read"));
        return paginate(
          repo.list("links", "task_id = ?", [taskId]),
          page,
          (item) => item.id,
        );
      });
    },

    addComment(
      actor: Actor,
      taskId: string,
      input: z.input<typeof commentInputSchema>,
      mutation: Mutation,
    ) {
      const data = commentInputSchema.parse(input);
      return write(
        actor,
        "tasks:write",
        "addComment",
        { taskId, data },
        mutation,
        (actor, mutation) => {
          let task = taskFor(actor, taskId, "tasks:write");
          checkWrite(actor, task, mutation);
          const reply =
            data.replyTo === undefined
              ? null
              : required(repo.get("comments", data.replyTo), "Comment");
          if (reply !== null && reply.taskId !== taskId)
            throw new BoardError("conflict", "Reply belongs to another task");
          if (data.kind === "answer" && reply?.kind !== "question")
            throw new BoardError(
              "conflict",
              "An answer must reply to a question",
            );
          const comment = repo.insert("comments", {
            ...data,
            replyTo: data.replyTo ?? null,
            id: id("cmt"),
            workspaceId,
            taskId,
            author: actor.principal.id,
            createdAt: at(),
          });
          task = saveTask(actor, task, "comment_added", {
            commentId: comment.id,
            kind: comment.kind,
          });
          const to =
            data.kind === "question"
              ? "input_required"
              : data.kind === "answer" && task.status === "input_required"
                ? "in_progress"
                : null;
          const result =
            to !== null && to !== task.status
              ? transitionTask(actor, task, to, task.statusMessage)
              : { task, approval: null };
          return { ...result, comment };
        },
        { taskIds: [taskId] },
      );
    },

    listComments(actor: Actor, taskId: string, page: PageInput) {
      return read(actor, "tasks:read", (actor) => {
        expired(actor, taskFor(actor, taskId, "tasks:read"));
        return paginate(
          repo.list("comments", "task_id = ?", [taskId]),
          page,
          (item) => item.id,
        );
      });
    },

    addArtifact(
      actor: Actor,
      taskId: string,
      input: Pick<Artifact, "name" | "mediaType" | "content">,
      mutation: Mutation,
    ) {
      const data = artifactInputSchema.parse(input);
      return write(
        actor,
        "tasks:write",
        "addArtifact",
        { taskId, data },
        mutation,
        (actor, mutation) => {
          const task = taskFor(actor, taskId, "tasks:write");
          checkWrite(actor, task, mutation);
          const previous = repo.list(
            "artifacts",
            "task_id = ? AND name = ?",
            [taskId, data.name],
            "version DESC",
          )[0];
          const artifact = repo.insert("artifacts", {
            ...data,
            id: id("art"),
            workspaceId,
            taskId,
            author: actor.principal.id,
            version: (previous?.version ?? 0) + 1,
            createdAt: at(),
          });
          return {
            artifact,
            task: saveTask(actor, task, "artifact_added", {
              artifactId: artifact.id,
              name: artifact.name,
              version: artifact.version,
            }),
          };
        },
        { taskIds: [taskId] },
      );
    },

    listArtifacts(actor: Actor, taskId: string, page: PageInput) {
      return read(actor, "tasks:read", (actor) => {
        expired(actor, taskFor(actor, taskId, "tasks:read"));
        return paginate(
          repo.list("artifacts", "task_id = ?", [taskId]),
          page,
          (item) => item.id,
        );
      });
    },

    createLabel(
      actor: Actor,
      projectId: string,
      name: string,
      mutation: Mutation = {},
    ) {
      z.string().parse(name);
      return write(
        actor,
        "projects:admin",
        "createLabel",
        { projectId, name },
        mutation,
        (actor) => {
          projectSettings(projectId);
          if (
            repo.list("labels", "project_id = ? AND name = ?", [
              projectId,
              name,
            ]).length
          )
            throw new BoardError("conflict", "Label already exists");
          const label = repo.insert("labels", {
            id: id("lbl"),
            workspaceId,
            projectId,
            name,
          });
          record(
            actor,
            "label_created",
            { labelId: label.id },
            undefined,
            projectId,
          );
          return label;
        },
        { access: (actor) => authorize(actor, "projects:admin", projectId) },
      );
    },

    listLabels(actor: Actor, projectId: string, page: PageInput) {
      return read(actor, "tasks:read", (actor) => {
        authorize(actor, "tasks:read", projectId);
        projectSettings(projectId);
        return paginate(
          repo.list("labels", "project_id = ?", [projectId]),
          page,
          (item) => item.id,
        );
      });
    },

    addLabel(
      actor: Actor,
      taskId: string,
      labelId: string,
      mutation: Mutation,
    ) {
      return write(
        actor,
        "tasks:write",
        "addLabel",
        { taskId, labelId },
        mutation,
        (actor, mutation) => {
          const task = taskFor(actor, taskId, "tasks:write");
          checkWrite(actor, task, mutation);
          validateLabels(task.projectId, [labelId]);
          return saveTask(
            actor,
            { ...task, labels: [...new Set([...task.labels, labelId])].sort() },
            "label_added",
            { labelId },
          );
        },
        { taskIds: [taskId] },
      );
    },

    removeLabel(
      actor: Actor,
      taskId: string,
      labelId: string,
      mutation: Mutation,
    ) {
      return write(
        actor,
        "tasks:write",
        "removeLabel",
        { taskId, labelId },
        mutation,
        (actor, mutation) => {
          const task = taskFor(actor, taskId, "tasks:write");
          checkWrite(actor, task, mutation);
          if (!task.labels.includes(labelId))
            throw new BoardError("not_found", "Label not found on task");
          return saveTask(
            actor,
            {
              ...task,
              labels: task.labels.filter((label) => label !== labelId),
            },
            "label_removed",
            { labelId },
          );
        },
        { taskIds: [taskId] },
      );
    },

    listEvents(
      actor: Actor,
      input: z.input<typeof eventQuerySchema>,
    ): Page<Event> {
      const query = eventQuerySchema.parse(input);
      return read(actor, "tasks:read", (actor) => {
        const events = eventsFor(actor, query);
        return paginate(
          events,
          query,
          (event) => String(event.seq),
          (event, cursor) => event.seq > z.coerce.number().int().parse(cursor),
        );
      });
    },
  };
}
