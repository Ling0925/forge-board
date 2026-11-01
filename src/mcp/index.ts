import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { name, version } from "../../package.json";
import {
  type Actor,
  BoardError,
  type Mutation,
  artifactInputSchema,
  commentInputSchema,
  createTaskSchema,
  linkInputSchema,
  mutationSchema,
  pageSchema,
  taskQuerySchema,
  taskSchema,
  transitionSchema,
  updateTaskSchema,
} from "../domain/index.js";
import type { createBoard } from "../service/index.js";

function result(run: () => unknown): CallToolResult {
  try {
    return { content: [{ type: "text", text: JSON.stringify(run()) }] };
  } catch (error) {
    if (!(error instanceof BoardError)) throw error;
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: {
              code: error.code,
              status: error.status,
              message: error.message,
              details: error.details,
            },
          }),
        },
      ],
    };
  }
}

export async function mcpResponse(
  board: ReturnType<typeof createBoard>,
  actor: Actor,
  request: Request,
) {
  const server = new McpServer({ name, version });
  const id = taskSchema.pick({ id: true });

  function tool<S extends z.ZodObject>(
    name: string,
    description: string,
    schema: S,
    run: (input: z.output<S>) => unknown,
  ) {
    const inputSchema: z.ZodObject = schema;
    server.registerTool(name, { description, inputSchema }, (input) =>
      result(() => run(schema.parse(input))),
    );
  }
  function mutate<S extends z.ZodObject>(
    name: string,
    description: string,
    schema: S,
    run: (input: z.output<S>, mutation: Mutation) => unknown,
  ) {
    tool(
      name,
      description,
      schema.extend(mutationSchema.shape),
      ({ idempotencyKey, expectedVersion, leaseToken, ...input }) =>
        run(
          schema.parse(input),
          mutationSchema.parse({ idempotencyKey, expectedVersion, leaseToken }),
        ),
    );
  }

  tool(
    "board_list",
    "List tasks, including the dependency-aware ready queue. Supply limit; continue with nextCursor.",
    taskQuerySchema,
    (input) => board.listTasks(actor, input),
  );
  tool(
    "board_get",
    "Get a task. Request related collections with {limit, cursor?}; each returns its own nextCursor.",
    id.extend({
      dependencies: pageSchema.optional(),
      links: pageSchema.optional(),
      comments: pageSchema.optional(),
      artifacts: pageSchema.optional(),
      approvals: pageSchema.optional(),
      events: pageSchema.optional(),
    }),
    (input) => ({
      task: board.getTask(actor, input.id),
      ...(input.dependencies && {
        dependencies: board.listDependencies(
          actor,
          input.id,
          input.dependencies,
        ),
      }),
      ...(input.links && {
        links: board.listLinks(actor, input.id, input.links),
      }),
      ...(input.comments && {
        comments: board.listComments(actor, input.id, input.comments),
      }),
      ...(input.artifacts && {
        artifacts: board.listArtifacts(actor, input.id, input.artifacts),
      }),
      ...(input.approvals && {
        approvals: board.listApprovals(actor, input.id, input.approvals),
      }),
      ...(input.events && {
        events: board.listEvents(actor, { ...input.events, taskId: input.id }),
      }),
    }),
  );
  mutate(
    "board_create",
    "Create a task with optional initial links and subtasks atomically. Subtasks inherit project and, unless supplied, accountable. Returns the parent; list children by parentId.",
    createTaskSchema,
    (input, mutation) => board.createTask(actor, input, mutation),
  );
  mutate(
    "board_update",
    "Update task fields with expectedVersion. The lease holder may omit it for progress/statusMessage, supplying leaseToken.",
    id.extend(updateTaskSchema.shape),
    ({ id, ...input }, mutation) =>
      board.updateTask(actor, id, input, mutation),
  );
  mutate(
    "board_claim",
    "Claim by id, or claim the next ready task using next:true and projectId. Returns task and any pending approval, or null when the queue is empty.",
    z.strictObject({
      id: taskSchema.shape.id.optional(),
      next: z.literal(true).optional(),
      projectId: taskSchema.shape.projectId.optional(),
    }),
    (input, mutation) => {
      const target = z
        .union([
          id,
          z.strictObject({
            next: z.literal(true),
            projectId: taskSchema.shape.projectId,
          }),
        ])
        .parse(input);
      return "id" in target
        ? board.claim(actor, target.id, mutation)
        : board.claimNext(actor, target.projectId, mutation);
    },
  );
  mutate(
    "board_release",
    "Release your claim using leaseToken and return the task to todo.",
    id,
    ({ id }, mutation) => board.release(actor, id, mutation),
  );
  mutate(
    "board_transition",
    "Change status with expectedVersion or the holder's leaseToken. Approval gates return a pending approval without applying the transition.",
    id.extend(transitionSchema.shape),
    ({ id, ...input }, mutation) =>
      board.transition(actor, id, input, mutation),
  );
  mutate(
    "board_comment",
    "Add comment, question, answer or decision with expectedVersion. A question requests input; an answer must replyTo a question. Holders also supply leaseToken.",
    id.extend(commentInputSchema.shape),
    ({ id, ...input }, mutation) =>
      board.addComment(actor, id, input, mutation),
  );
  mutate(
    "board_artifact",
    "Add a versioned artifact with expectedVersion and, for holders, leaseToken. content is {uri, text:null} or {uri:null, text}.",
    id.extend(artifactInputSchema.shape),
    ({ id, ...input }, mutation) =>
      board.addArtifact(actor, id, input, mutation),
  );
  mutate(
    "board_link",
    "Add a thread, session, pr, issue, url or task reference with expectedVersion and, for holders, leaseToken.",
    id.extend(linkInputSchema.shape),
    ({ id, ...input }, mutation) => board.addLink(actor, id, input, mutation),
  );

  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    let parsedBody: unknown;
    try {
      parsedBody = await request.json();
    } catch {
      throw new BoardError(
        "validation_error",
        "Request body must be valid JSON",
      );
    }
    return await transport.handleRequest(request, { parsedBody });
  } finally {
    await server.close();
  }
}
