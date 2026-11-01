import { z } from "zod";

export const DEFAULT_WORKSPACE_ID = "default";
export const timestampSchema = z.iso.datetime();
const id = z.string().min(1);
const entity = { id, workspaceId: id };
export const statusSchema = z.enum([
  "todo",
  "in_progress",
  "input_required",
  "blocked",
  "in_review",
  "done",
  "failed",
  "canceled",
]);
export type Status = z.infer<typeof statusSchema>;
export const scopeSchema = z.enum([
  "tasks:read",
  "tasks:write",
  "tasks:claim",
  "tasks:assign",
  "tasks:approve",
  "projects:admin",
  "tokens:admin",
]);
export type Scope = z.infer<typeof scopeSchema>;
export const approvalRuleSchema = z.templateLiteral([
  z.union([statusSchema, z.literal("*")]),
  "->",
  statusSchema,
]);
export const projectSettingsSchema = z.strictObject({
  leaseTtl: z
    .number()
    .positive()
    .optional()
    .describe("Lease duration in milliseconds; omitted means no expiry"),
  allowAgentAssignment: z.boolean().optional(),
  approvalRequired: z.array(approvalRuleSchema).optional(),
});
export type ProjectSettings = z.infer<typeof projectSettingsSchema>;
export const settingsSchema = z.strictObject({
  idempotencyRetention: z
    .number()
    .positive()
    .optional()
    .describe("Retention in milliseconds; omitted means indefinite retention"),
  maxPageSize: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("bounds one response's memory"),
});
export type Settings = z.infer<typeof settingsSchema>;
export const workspaceSchema = z.strictObject({ ...entity, name: z.string() });
export type Workspace = z.infer<typeof workspaceSchema>;
export const projectSchema = z.strictObject({
  ...entity,
  key: z.string().min(1),
  name: z.string(),
  settings: projectSettingsSchema,
});
export type Project = z.infer<typeof projectSchema>;
export const principalSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...entity,
    kind: z.literal("human"),
    name: z.string(),
    owner: z.null(),
    disabled: z.boolean(),
  }),
  z.strictObject({
    ...entity,
    kind: z.literal("agent"),
    name: z.string(),
    owner: id,
    disabled: z.boolean(),
  }),
]);
export type Principal = z.infer<typeof principalSchema>;
export const tokenSchema = z.strictObject({
  ...entity,
  principalId: id,
  hash: z.string(),
  scopes: z.array(scopeSchema),
  projectIds: z.array(id).nullable(),
  createdAt: timestampSchema,
  expiresAt: timestampSchema.nullable(),
  lastUsedAt: timestampSchema.nullable(),
  revokedAt: timestampSchema.nullable(),
});
export type Token = z.infer<typeof tokenSchema>;
export const actorSchema = z.strictObject({
  principal: principalSchema,
  scopes: z.array(scopeSchema),
  projectIds: z.array(id).nullable(),
  tokenId: id.optional(),
});
export type Actor = z.infer<typeof actorSchema>;
export const leaseSchema = z.strictObject({
  holder: id,
  token: id,
  expiresAt: timestampSchema.nullable(),
});
export const taskSchema = z.strictObject({
  ...entity,
  projectId: id,
  number: z.number().int().positive(),
  title: z.string(),
  description: z.string(),
  status: statusSchema,
  statusMessage: z.string(),
  accountable: id,
  assignee: id.nullable(),
  lease: leaseSchema.nullable(),
  parentId: id.nullable(),
  priority: z.number().int(),
  labels: z.array(id),
  authorization: z.enum(["explicit", "inferred"]).nullable(),
  progress: z.string(),
  metadata: z.record(z.string(), z.json()),
  version: z.number().int().positive(),
  createdBy: id,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Task = z.infer<typeof taskSchema>;
export const dependencySchema = z.strictObject({
  ...entity,
  taskId: id,
  dependsOnId: id,
});
export type Dependency = z.infer<typeof dependencySchema>;
export const linkKindSchema = z.enum([
  "thread",
  "session",
  "pr",
  "issue",
  "url",
  "task",
]);
export const linkSchema = z.strictObject({
  ...entity,
  taskId: id,
  kind: linkKindSchema,
  ref: z.string(),
  title: z.string().nullable(),
});
export type Link = z.infer<typeof linkSchema>;
export const commentKindSchema = z.enum([
  "comment",
  "question",
  "answer",
  "decision",
]);
export const commentSchema = z.strictObject({
  ...entity,
  taskId: id,
  author: id,
  body: z.string(),
  kind: commentKindSchema,
  replyTo: id.nullable(),
  createdAt: timestampSchema,
});
export type Comment = z.infer<typeof commentSchema>;
export const artifactContentSchema = z.union([
  z.strictObject({ uri: z.string(), text: z.null() }),
  z.strictObject({ uri: z.null(), text: z.string() }),
]);
export const artifactSchema = z.strictObject({
  ...entity,
  taskId: id,
  author: id,
  name: z.string(),
  mediaType: z.string(),
  content: artifactContentSchema,
  version: z.number().int().positive(),
  createdAt: timestampSchema,
});
export type Artifact = z.infer<typeof artifactSchema>;
export const labelSchema = z.strictObject({
  ...entity,
  projectId: id,
  name: z.string(),
});
export type Label = z.infer<typeof labelSchema>;
export const approvalSchema = z.strictObject({
  ...entity,
  taskId: id,
  action: z.enum(["transition", "claim"]),
  from: statusSchema,
  to: statusSchema,
  message: z.string(),
  taskVersion: z.number().int().positive(),
  requestedBy: id,
  state: z.enum(["pending", "approved", "rejected"]),
  decidedBy: id.nullable(),
  createdAt: timestampSchema,
  decidedAt: timestampSchema.nullable(),
});
export type Approval = z.infer<typeof approvalSchema>;
export const eventSchema = z.strictObject({
  seq: z.number().int().positive(),
  workspaceId: id,
  projectId: id.nullable(),
  taskId: id.nullable(),
  type: z.string(),
  actor: id,
  owner: id.nullable(),
  data: z.record(z.string(), z.json()),
  at: timestampSchema,
});
export type Event = z.infer<typeof eventSchema>;
export const idempotencyRecordSchema = z.strictObject({
  workspaceId: id,
  principalId: id,
  key: z.string(),
  requestHash: z.string(),
  response: z.json(),
  createdAt: timestampSchema,
});
export type IdempotencyRecord = z.infer<typeof idempotencyRecordSchema>;
export const mutationSchema = z.strictObject({
  idempotencyKey: z.string().optional(),
  expectedVersion: z.number().int().positive().optional(),
  leaseToken: id.optional(),
});
export type Mutation = z.infer<typeof mutationSchema>;
export const pageSchema = z.strictObject({
  cursor: z.string().optional(),
  limit: z.number().int().positive(),
});
export type PageInput = z.infer<typeof pageSchema>;
export type Page<T> = { items: T[]; nextCursor: string | null };
export const createTaskSchema = taskSchema
  .pick({
    projectId: true,
    title: true,
    accountable: true,
  })
  .extend(
    taskSchema
      .pick({
        description: true,
        assignee: true,
        parentId: true,
        priority: true,
        authorization: true,
        metadata: true,
        labels: true,
      })
      .partial().shape,
  );
export type CreateTask = z.infer<typeof createTaskSchema>;
export const updateTaskSchema = taskSchema
  .pick({
    title: true,
    description: true,
    statusMessage: true,
    accountable: true,
    assignee: true,
    parentId: true,
    priority: true,
    authorization: true,
    progress: true,
    metadata: true,
  })
  .exactPartial();
export type UpdateTask = z.infer<typeof updateTaskSchema>;
export const taskQuerySchema = pageSchema.extend({
  projectId: id.optional(),
  status: statusSchema.optional(),
  assignee: id.optional(),
  label: id.optional(),
  link: z.string().optional(),
  ready: z.boolean().optional(),
  parentId: id.optional(),
});
export type TaskQuery = z.infer<typeof taskQuerySchema>;
