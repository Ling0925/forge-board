import { z } from "zod";
import pkg from "../../package.json";
import { errorStatuses } from "../domain/index.js";

export const errorSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum(Object.keys(errorStatuses)),
    message: z.string(),
    details: z.json(),
  }),
});
export const mutationHeadersSchema = z.object({
  "Idempotency-Key": z.string().optional(),
  "If-Match": z
    .string()
    .regex(/^(?:[1-9]\d*|"[1-9]\d*")$/)
    .optional()
    .describe("Task version, optionally quoted as an ETag"),
});

export function createOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {};
  const schemas: Record<string, unknown> = {};
  function jsonSchema(schema: z.ZodType) {
    const name = `Schema${Object.keys(schemas).length}`;
    const ref = `#/components/schemas/${name}`;
    // Relocate schema-local refs into the enclosing OpenAPI document.
    schemas[name] = JSON.parse(
      JSON.stringify(
        z.toJSONSchema(schema, {
          target: "draft-2020-12",
          io: "input",
        }),
        (key, value: unknown) =>
          key === "$ref" && typeof value === "string" && value.startsWith("#")
            ? `${ref}${value.slice(1)}`
            : value,
      ),
    );
    return { $ref: ref };
  }
  function parameters(schema: z.ZodObject, location: "query" | "header") {
    return Object.entries(schema.shape).map(([name, field]) => ({
      name,
      in: location,
      required: !field.isOptional(),
      schema: jsonSchema(field),
    }));
  }
  const document = {
    openapi: "3.1.0",
    info: { title: "forge-board", version: pkg.version },
    security: [{ bearerAuth: [] }],
    components: {
      schemas,
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    },
    paths,
  };
  function add(
    method: string,
    path: string,
    options: {
      body?: z.ZodType;
      query?: z.ZodObject;
      response: z.ZodType;
      task?: boolean;
      events?: boolean;
      public?: boolean;
    },
  ) {
    const url = path.replace(/:([^/]+)/g, "{$1}");
    const params: object[] = [...path.matchAll(/:([^/]+)/g)].map((match) => ({
      name: match[1],
      in: "path",
      required: true,
      schema: jsonSchema(z.string()),
    }));
    if (options.query) params.push(...parameters(options.query, "query"));
    if (method !== "get")
      params.push(...parameters(mutationHeadersSchema, "header"));
    if (options.events)
      params.push(
        ...parameters(
          z.object({
            "Last-Event-ID": z.string().regex(/^\d+$/).optional(),
            Accept: z
              .string()
              .optional()
              .describe("text/event-stream selects SSE; otherwise a JSON page"),
          }),
          "header",
        ),
      );
    const responses: Record<string, unknown> = {
      "200": {
        description: "Success",
        ...(options.task
          ? {
              headers: {
                ETag: {
                  schema: jsonSchema(z.string()),
                  description: "Quoted task version",
                },
              },
            }
          : {}),
        content: {
          "application/json": { schema: jsonSchema(options.response) },
          ...(options.events
            ? {
                "text/event-stream": {
                  schema: jsonSchema(
                    z
                      .string()
                      .describe(
                        "SSE frames: id is event seq, data is the JSON event",
                      ),
                  ),
                },
              }
            : {}),
        },
      },
    };
    for (const status of new Set(Object.values(errorStatuses)))
      responses[status] = {
        description: "Request failed",
        content: { "application/json": { schema: jsonSchema(errorSchema) } },
      };
    paths[url] ??= {};
    paths[url][method] = {
      operationId: `${method}_${path.replace(/[^a-zA-Z0-9]+/g, "_")}`,
      parameters: params,
      ...(options.public ? { security: [] } : {}),
      ...(options.body
        ? {
            requestBody: {
              required: !options.body.safeParse({}).success,
              content: {
                "application/json": { schema: jsonSchema(options.body) },
              },
            },
          }
        : {}),
      responses,
    };
  }
  return { document, add };
}
