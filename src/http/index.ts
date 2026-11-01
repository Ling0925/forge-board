import { type Context, Hono } from "hono";
import { z } from "zod";
import {
  type Actor,
  BoardError,
  type Mutation,
  type Task,
  approvalDecisionSchema,
  approvalQuerySchema,
  approvalSchema,
  artifactInputSchema,
  artifactSchema,
  commentInputSchema,
  commentSchema,
  createProjectSchema,
  createTaskSchema,
  dependencySchema,
  eventFilterSchema,
  eventSchema,
  labelSchema,
  linkInputSchema,
  linkSchema,
  mutationSchema,
  pageSchema,
  principalInputSchema,
  principalSchema,
  projectSchema,
  taskQuerySchema,
  taskSchema,
  tokenInputSchema,
  tokenSchema,
  transitionSchema,
  updateProjectSchema,
  updateTaskSchema,
} from "../domain/index.js";
import type { createBoard } from "../service/index.js";
import { eventStream } from "./events.js";
import { createOpenApi, mutationHeadersSchema } from "./openapi.js";

type Env = { Variables: { actor: Actor } };
const empty = z.strictObject({});
const pageQuery = pageSchema.extend({
  limit: z.coerce.number().int().positive(),
});
const pageOf = <S extends z.ZodType>(schema: S) =>
  z.strictObject({ items: z.array(schema), nextCursor: z.string().nullable() });
const transitionResult = z.strictObject({
  task: taskSchema,
  approval: approvalSchema.nullable(),
});
const tokenMetadata = tokenSchema.omit({ hash: true });
const eventQuery = pageQuery.extend({
  after: z.coerce.number().int().nonnegative().optional(),
  project: eventFilterSchema.shape.projectId,
  task: eventFilterSchema.shape.taskId,
});

function json(c: Context, value: unknown, task = false) {
  if (task && value !== null) {
    const parsed = value as Task | { task: Task };
    c.header(
      "ETag",
      `"${"task" in parsed ? parsed.task.version : parsed.version}"`,
    );
  }
  return c.json(value);
}

export function createApp(board: ReturnType<typeof createBoard>) {
  const app = new Hono<Env>();
  const openapi = createOpenApi();
  app.onError((error, c) => {
    const failure =
      error instanceof z.ZodError
        ? new BoardError("validation_error", "Invalid request", error.issues)
        : error;
    if (failure instanceof BoardError) {
      if (failure.status === 401) c.header("WWW-Authenticate", "Bearer");
      return c.json(
        {
          error: {
            code: failure.code,
            message: failure.message,
            details: failure.details,
          },
        },
        failure.status,
      );
    }
    throw error;
  });
  app.notFound(() => {
    throw new BoardError("not_found", "Route not found");
  });
  openapi.add("get", "/v1/openapi.json", {
    response: z.record(z.string(), z.json()),
    public: true,
  });
  app.get("/v1/openapi.json", (c) => c.json(openapi.document));
  app.use("/v1/*", async (c, next) => {
    const match = /^Bearer\s+(\S+)$/i.exec(c.req.header("Authorization") ?? "");
    if (!match?.[1])
      throw new BoardError("unauthorized", "A Bearer token is required");
    c.set("actor", board.verifyToken(match[1]));
    await next();
  });

  function get<Q extends z.ZodObject>(
    path: string,
    query: Q,
    response: z.ZodType,
    run: (actor: Actor, query: z.output<Q>, id: string) => unknown,
    task = false,
  ) {
    openapi.add("get", path, { query, response, task });
    app.get(path, (c) =>
      json(
        c,
        run(
          c.get("actor"),
          query.parse(c.req.query()),
          c.req.param("id") as string,
        ),
        task,
      ),
    );
  }
  function mutate<B extends z.ZodObject | z.ZodDiscriminatedUnion>(
    method: "post" | "patch" | "delete",
    path: string,
    body: B,
    response: z.ZodType,
    run: (
      actor: Actor,
      body: z.output<B>,
      mutation: Mutation,
      id: string,
    ) => unknown,
    task = false,
  ) {
    const leaseShape = mutationSchema.pick({ leaseToken: true }).shape;
    const requestSchema =
      body instanceof z.ZodObject
        ? body.extend(leaseShape)
        : z.union(
            body.options.map((option) => {
              const object = option as z.ZodObject;
              return object.extend(leaseShape);
            }),
          );
    openapi.add(method, path, { body: requestSchema, response, task });
    app.on(method.toUpperCase(), path, async (c) => {
      const raw = await c.req.text();
      let input: unknown = {};
      if (raw) {
        try {
          input = JSON.parse(raw);
        } catch {
          throw new BoardError(
            "validation_error",
            "Request body must be valid JSON",
          );
        }
      }
      const { leaseToken, ...data } = requestSchema.parse(input) as Record<
        string,
        unknown
      >;
      const headers = mutationHeadersSchema.parse({
        "Idempotency-Key": c.req.header("Idempotency-Key"),
        "If-Match": c.req.header("If-Match"),
      });
      const version = headers["If-Match"];
      const mutation = mutationSchema.parse({
        idempotencyKey: headers["Idempotency-Key"],
        leaseToken,
        expectedVersion:
          version === undefined
            ? undefined
            : Number(version.replaceAll('"', "")),
      });
      return json(
        c,
        run(
          c.get("actor"),
          data as z.output<B>,
          mutation,
          c.req.param("id") as string,
        ),
        task,
      );
    });
  }

  get("/v1/projects", pageQuery, pageOf(projectSchema), (a, q) =>
    board.listProjects(a, q),
  );
  mutate(
    "post",
    "/v1/projects",
    createProjectSchema,
    projectSchema,
    (a, b, m) => board.createProject(a, b, m),
  );
  get("/v1/projects/:id", empty, projectSchema, (a, _, id) =>
    board.getProject(a, id),
  );
  mutate(
    "patch",
    "/v1/projects/:id",
    updateProjectSchema,
    projectSchema,
    (a, b, m, id) => board.updateProject(a, id, b, m),
  );
  get("/v1/projects/:id/labels", pageQuery, pageOf(labelSchema), (a, q, id) =>
    board.listLabels(a, id, q),
  );
  mutate(
    "post",
    "/v1/projects/:id/labels",
    labelSchema.pick({ name: true }),
    labelSchema,
    (a, b, m, id) => board.createLabel(a, id, b.name, m),
  );

  const tasksQuery = taskQuerySchema.omit({ projectId: true }).extend({
    ...pageQuery.shape,
    project: taskQuerySchema.shape.projectId,
    ready: z.enum(["true", "false"]).optional(),
  });
  get(
    "/v1/tasks",
    tasksQuery,
    pageOf(taskSchema),
    (a, { project, ready, ...q }) =>
      board.listTasks(a, {
        ...q,
        ...(project === undefined ? {} : { projectId: project }),
        ...(ready === undefined ? {} : { ready: ready === "true" }),
      }),
  );
  mutate(
    "post",
    "/v1/tasks",
    createTaskSchema,
    taskSchema,
    (a, b, m) => board.createTask(a, b, m),
    true,
  );
  get(
    "/v1/tasks/:id",
    empty,
    taskSchema,
    (a, _, id) => board.getTask(a, id),
    true,
  );
  mutate(
    "patch",
    "/v1/tasks/:id",
    updateTaskSchema,
    taskSchema,
    (a, b, m, id) => board.updateTask(a, id, b, m),
    true,
  );
  mutate(
    "post",
    "/v1/tasks/claim-next",
    taskSchema.pick({ projectId: true }),
    transitionResult.nullable(),
    (a, b, m) => board.claimNext(a, b.projectId, m),
    true,
  );
  for (const action of ["claim", "release", "reclaim"] as const)
    mutate(
      "post",
      `/v1/tasks/:id/${action}`,
      empty,
      transitionResult,
      (a, _, m, id) => board[action](a, id, m),
      true,
    );
  mutate(
    "post",
    "/v1/tasks/:id/lease/renew",
    empty,
    taskSchema,
    (a, _, m, id) => board.renewLease(a, id, m),
    true,
  );
  mutate(
    "post",
    "/v1/tasks/:id/transition",
    transitionSchema,
    transitionResult,
    (a, b, m, id) => board.transition(a, id, b, m),
    true,
  );

  get("/v1/tasks/:id/links", pageQuery, pageOf(linkSchema), (a, q, id) =>
    board.listLinks(a, id, q),
  );
  mutate(
    "post",
    "/v1/tasks/:id/links",
    linkInputSchema,
    z.strictObject({ link: linkSchema, task: taskSchema }),
    (a, b, m, id) => board.addLink(a, id, b, m),
    true,
  );
  mutate(
    "delete",
    "/v1/tasks/:id/links",
    z.strictObject({ linkId: linkSchema.shape.id }),
    taskSchema,
    (a, b, m, id) => board.removeLink(a, id, b.linkId, m),
    true,
  );
  get(
    "/v1/tasks/:id/dependencies",
    pageQuery,
    pageOf(dependencySchema),
    (a, q, id) => board.listDependencies(a, id, q),
  );
  mutate(
    "post",
    "/v1/tasks/:id/dependencies",
    dependencySchema.pick({ dependsOnId: true }),
    z.strictObject({ dependency: dependencySchema, task: taskSchema }),
    (a, b, m, id) => board.addDependency(a, id, b.dependsOnId, m),
    true,
  );
  mutate(
    "delete",
    "/v1/tasks/:id/dependencies",
    z.strictObject({ dependencyId: dependencySchema.shape.id }),
    taskSchema,
    (a, b, m, id) => board.removeDependency(a, id, b.dependencyId, m),
    true,
  );
  for (const method of ["post", "delete"] as const)
    mutate(
      method,
      "/v1/tasks/:id/labels",
      z.strictObject({ labelId: labelSchema.shape.id }),
      taskSchema,
      (a, b, m, id) =>
        board[method === "post" ? "addLabel" : "removeLabel"](
          a,
          id,
          b.labelId,
          m,
        ),
      true,
    );
  get("/v1/tasks/:id/comments", pageQuery, pageOf(commentSchema), (a, q, id) =>
    board.listComments(a, id, q),
  );
  mutate(
    "post",
    "/v1/tasks/:id/comments",
    commentInputSchema,
    transitionResult.extend({ comment: commentSchema }),
    (a, b, m, id) => board.addComment(a, id, b, m),
    true,
  );
  get(
    "/v1/tasks/:id/artifacts",
    pageQuery,
    pageOf(artifactSchema),
    (a, q, id) => board.listArtifacts(a, id, q),
  );
  mutate(
    "post",
    "/v1/tasks/:id/artifacts",
    artifactInputSchema,
    z.strictObject({ artifact: artifactSchema, task: taskSchema }),
    (a, b, m, id) => board.addArtifact(a, id, b, m),
    true,
  );

  get(
    "/v1/tasks/:id/approvals",
    pageQuery,
    pageOf(approvalSchema),
    (a, q, id) => board.listApprovals(a, id, q),
  );
  get(
    "/v1/approvals",
    pageQuery.extend({
      project: approvalQuerySchema.shape.projectId,
      task: approvalQuerySchema.shape.taskId,
      state: approvalQuerySchema.shape.state,
    }),
    pageOf(approvalSchema),
    (a, { project, task, ...q }) =>
      board.queryApprovals(a, { ...q, projectId: project, taskId: task }),
  );
  mutate(
    "post",
    "/v1/approvals/:id/decide",
    z.strictObject({ decision: approvalDecisionSchema }),
    transitionResult,
    (a, b, m, id) => board.decideApproval(a, id, b.decision, m),
    true,
  );

  get("/v1/principals", pageQuery, pageOf(principalSchema), (a, q) =>
    board.listPrincipals(a, q),
  );
  mutate(
    "post",
    "/v1/principals",
    principalInputSchema,
    principalSchema,
    (a, b, m) => board.createPrincipal(a, b, m),
  );
  mutate(
    "post",
    "/v1/principals/:id/disable",
    empty,
    principalSchema,
    (a, _, m, id) => board.disablePrincipal(a, id, m),
  );
  get("/v1/tokens", pageQuery, pageOf(tokenMetadata), (a, q) =>
    board.listTokens(a, q),
  );
  mutate(
    "post",
    "/v1/tokens",
    tokenInputSchema,
    z.strictObject({
      token: tokenMetadata,
      secret: z
        .string()
        .nullable()
        .describe("Returned once; idempotent replay returns null"),
    }),
    (a, b, m) => board.createToken(a, b, m),
  );
  mutate("post", "/v1/tokens/:id/revoke", empty, tokenMetadata, (a, _, m, id) =>
    board.revokeToken(a, id, m),
  );

  openapi.add("get", "/v1/events", {
    query: eventQuery.extend({
      limit: pageQuery.shape.limit
        .optional()
        .describe("Required for JSON pages; omitted for SSE"),
    }),
    response: pageOf(eventSchema),
    events: true,
  });
  app.get("/v1/events", (c) => {
    const stream = c.req
      .header("Accept")
      ?.split(",")
      .some((value) => value.split(";")[0]?.trim() === "text/event-stream");
    const input = {
      ...c.req.query(),
      after: c.req.header("Last-Event-ID") ?? c.req.query("after"),
    };
    if (stream) {
      const { project, task, after } = eventQuery
        .omit({ limit: true, cursor: true })
        .parse(input);
      return eventStream(c, board, c.get("actor"), {
        projectId: project,
        taskId: task,
        after,
      });
    }
    const { project, task, ...query } = eventQuery.parse(input);
    return c.json(
      board.listEvents(c.get("actor"), {
        ...query,
        projectId: project,
        taskId: task,
      }),
    );
  });
  return app;
}
