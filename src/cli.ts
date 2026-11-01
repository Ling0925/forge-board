#!/usr/bin/env node
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import {
  BoardError,
  approvalQuerySchema,
  mutationSchema,
  pageSchema,
  portSchema,
  principalInputSchema,
  projectSettingsSchema,
  tokenInputSchema,
} from "./domain/index.js";
import { createApp } from "./http/index.js";
import { startProxy } from "./mcp/proxy.js";
import { createBoard } from "./service/index.js";

const usage = `forge-board <command> --data <dir>
  init --name <human name>
  serve [--host <host>] [--port <port>] (port may be set in config.json)
  mcp --url <server> --token <token> (or FORGE_BOARD_URL/FORGE_BOARD_TOKEN; no --data)
  principal create --kind human|agent --name <name> [--owner <human id>]
  principal list [--limit <n>] [--cursor <cursor>]
  principal disable <id>
  token create --principal <id> --scopes <comma-separated scopes> [--projects <comma-separated ids>] [--expires-at <ISO timestamp>]
  token list [--limit <n>] [--cursor <cursor>]
  token revoke <id>
  project create --key <key> --name <name> [--settings <JSON>]
  project list [--limit <n>] [--cursor <cursor>]
  project settings <id> --settings <JSON>
  approvals list [--limit <n>] [--project <id>] [--task <id>] [--state pending|approved|rejected] [--cursor <cursor>]
  approvals approve|reject <id> --expected-version <task version> [--lease-token <token>]
Administration commands require --token <Bearer token> and accept --idempotency-key <key>.`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      data: { type: "string" },
      host: { type: "string" },
      port: { type: "string" },
      name: { type: "string" },
      kind: { type: "string" },
      owner: { type: "string" },
      token: { type: "string" },
      url: { type: "string" },
      principal: { type: "string" },
      scopes: { type: "string" },
      projects: { type: "string" },
      "expires-at": { type: "string" },
      key: { type: "string" },
      settings: { type: "string" },
      project: { type: "string" },
      task: { type: "string" },
      state: { type: "string" },
      limit: { type: "string" },
      cursor: { type: "string" },
      "expected-version": { type: "string" },
      "lease-token": { type: "string" },
      "idempotency-key": { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help || positionals.length === 0) {
    console.log(usage);
    return;
  }
  const required = (value: string | undefined, label: string) => {
    if (value === undefined) throw new Error(`${label} is required`);
    return value;
  };
  const output = (value: unknown) =>
    console.log(JSON.stringify(value, null, 2));
  if (positionals[0] === "mcp") {
    await startProxy(
      required(
        values.url ?? process.env.FORGE_BOARD_URL,
        "--url or FORGE_BOARD_URL",
      ),
      required(
        values.token ?? process.env.FORGE_BOARD_TOKEN,
        "--token or FORGE_BOARD_TOKEN",
      ),
    );
    return;
  }
  const board = createBoard({ dataDir: required(values.data, "--data") });
  let serving = false;
  try {
    const [command, action, id] = positionals;
    if (command === "init") {
      output(board.initialize(required(values.name, "--name")));
      return;
    }
    if (command === "serve") {
      const port =
        values.port === undefined
          ? board.settings.port
          : portSchema.parse(Number(values.port));
      if (port === undefined)
        throw new Error(
          "Port is required: pass --port or set port in the data directory's config.json",
        );
      const hostname = values.host ?? "127.0.0.1";
      serve({ fetch: createApp(board).fetch, hostname, port }, (info) => {
        console.log(`forge-board listening on http://${hostname}:${info.port}`);
      });
      serving = true;
      return;
    }
    const actor = board.verifyToken(required(values.token, "--token"));
    const mutation = mutationSchema.parse({
      idempotencyKey: values["idempotency-key"],
      leaseToken: values["lease-token"],
      expectedVersion:
        values["expected-version"] === undefined
          ? undefined
          : Number(values["expected-version"]),
    });
    const page = () =>
      pageSchema.parse({
        limit: values.limit === undefined ? undefined : Number(values.limit),
        cursor: values.cursor,
      });
    const entityId = () => required(id, "Entity id");
    const settings = () =>
      projectSettingsSchema.parse(
        JSON.parse(required(values.settings, "--settings")),
      );
    switch (`${command} ${action}`) {
      case "principal create":
        output(
          board.createPrincipal(
            actor,
            principalInputSchema.parse({
              kind: required(values.kind, "--kind"),
              name: required(values.name, "--name"),
              ...(values.owner === undefined ? {} : { owner: values.owner }),
            }),
            mutation,
          ),
        );
        break;
      case "principal list":
        output(board.listPrincipals(actor, page()));
        break;
      case "principal disable":
        output(board.disablePrincipal(actor, entityId(), mutation));
        break;
      case "token create":
        output(
          board.createToken(
            actor,
            tokenInputSchema.parse({
              principalId: required(values.principal, "--principal"),
              scopes: required(values.scopes, "--scopes")
                .split(",")
                .filter(Boolean),
              projectIds: values.projects?.split(",").filter(Boolean),
              expiresAt: values["expires-at"],
            }),
            mutation,
          ),
        );
        break;
      case "token list":
        output(board.listTokens(actor, page()));
        break;
      case "token revoke":
        output(board.revokeToken(actor, entityId(), mutation));
        break;
      case "project create":
        output(
          board.createProject(
            actor,
            {
              key: required(values.key, "--key"),
              name: required(values.name, "--name"),
              ...(values.settings === undefined
                ? {}
                : { settings: settings() }),
            },
            mutation,
          ),
        );
        break;
      case "project list":
        output(board.listProjects(actor, page()));
        break;
      case "project settings":
        output(
          board.updateProject(
            actor,
            entityId(),
            { settings: settings() },
            mutation,
          ),
        );
        break;
      case "approvals list":
        output(
          board.queryApprovals(actor, {
            ...page(),
            projectId: values.project,
            taskId: values.task,
            ...(values.state === undefined
              ? {}
              : {
                  state: approvalQuerySchema.shape.state.parse(values.state),
                }),
          }),
        );
        break;
      case "approvals approve":
      case "approvals reject":
        output(
          board.decideApproval(
            actor,
            entityId(),
            action === "approve" ? "approved" : "rejected",
            mutation,
          ),
        );
        break;
      default:
        throw new Error(`Unknown command: ${positionals.join(" ")}\n${usage}`);
    }
  } finally {
    if (!serving) board.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(
    error instanceof BoardError
      ? `${error.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error),
  );
  process.exitCode = 1;
}
