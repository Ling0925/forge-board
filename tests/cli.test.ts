import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createBoard } from "../src/service/index.js";
import { temporaryDirectory } from "./helpers.js";

const executable = resolve("dist/cli.js");
beforeAll(() => {
  execFileSync(process.execPath, ["scripts/build.mjs"], { stdio: "pipe" });
});

function cli(directory: string, args: string[], token?: string) {
  return spawnSync(
    process.execPath,
    [
      executable,
      ...args,
      "--data",
      directory,
      ...(token === undefined ? [] : ["--token", token]),
    ],
    { encoding: "utf8" },
  );
}
function json(directory: string, args: string[], token?: string) {
  const result = cli(directory, args, token);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

async function serving(
  directory: string,
  args: string[],
  run: (url: string) => Promise<void>,
) {
  const child = spawn(
    process.execPath,
    [executable, "serve", "--data", directory, ...args],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  const exited = once(child, "exit");
  try {
    const address = new Promise<string>((resolve, reject) => {
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
        const match = /listening on (http:\/\/\S+)/.exec(output);
        if (match?.[1]) resolve(match[1]);
      });
      child.once("error", reject);
      child.once("exit", () => reject(new Error(errors)));
    });
    await run(await address);
  } finally {
    child.kill();
    await exited;
  }
}

describe("built CLI", () => {
  it("initializes once, persists only token hashes, and administers principals, tokens, and projects", () => {
    const directory = join(temporaryDirectory(), "new-board");
    const init = json(directory, ["init", "--name", "First human"]);
    expect(init.workspace.id).toBe("default");
    expect(init.principal).toMatchObject({
      kind: "human",
      name: "First human",
    });
    expect(init.secret).toMatch(/^fbt_/);
    expect(init.token.scopes).toContain("tokens:admin");
    expect(init.token).not.toHaveProperty("hash");
    expect(
      JSON.parse(readFileSync(join(directory, "config.json"), "utf8")),
    ).toEqual({});
    const repeat = cli(directory, ["init", "--name", "Again"]);
    expect(repeat.status).toBe(1);
    expect(repeat.stderr).toContain("already initialized");
    expect(repeat.stdout).toBe("");
    const human = json(
      directory,
      ["principal", "create", "--kind", "human", "--name", "Owner"],
      init.secret,
    );
    const agent = json(
      directory,
      [
        "principal",
        "create",
        "--kind",
        "agent",
        "--owner",
        human.id,
        "--name",
        "Worker",
      ],
      init.secret,
    );
    expect(
      json(directory, ["principal", "list", "--limit", "10"], init.secret)
        .items,
    ).toContainEqual(agent);
    const project = json(
      directory,
      ["project", "create", "--key", "CLI", "--name", "CLI"],
      init.secret,
    );
    expect(
      json(directory, ["project", "list", "--limit", "10"], init.secret).items,
    ).toEqual([project]);
    expect(
      json(
        directory,
        ["project", "settings", project.id, "--settings", '{"leaseTtl":1000}'],
        init.secret,
      ).settings,
    ).toEqual({ leaseTtl: 1000 });
    const args = [
      "token",
      "create",
      "--principal",
      agent.id,
      "--scopes",
      "tasks:read,tasks:claim",
      "--projects",
      project.id,
      "--expires-at",
      "2099-01-01T00:00:00.000Z",
      "--idempotency-key",
      "agent-token",
    ];
    const token = json(directory, args, init.secret);
    expect(token.token).toMatchObject({
      scopes: ["tasks:read", "tasks:claim"],
      projectIds: [project.id],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(json(directory, args, init.secret)).toEqual({
      ...token,
      secret: null,
    });
    const tokens = json(
      directory,
      ["token", "list", "--limit", "10"],
      init.secret,
    );
    expect(tokens.items).toContainEqual(token.token);
    expect(JSON.stringify(tokens)).not.toContain(token.secret);
    expect(
      readFileSync(join(directory, "board.sqlite")).includes(
        Buffer.from(token.secret),
      ),
    ).toBe(false);
    expect(
      json(directory, ["token", "revoke", token.token.id], init.secret)
        .revokedAt,
    ).not.toBeNull();
    expect(
      cli(directory, ["project", "list", "--limit", "10"], token.secret).status,
    ).toBe(1);
    expect(
      json(directory, ["principal", "disable", agent.id], init.secret).disabled,
    ).toBe(true);
    expect(cli(directory, ["token", "list", "--limit", "10"]).stderr).toContain(
      "--token is required",
    );
  });

  it("lists, approves, and rejects via the service using a human token and expected version", () => {
    const directory = temporaryDirectory();
    const init = json(directory, ["init", "--name", "Admin"]);
    const board = createBoard({ dataDir: directory });
    try {
      const admin = board.verifyToken(init.secret);
      const agent = board.createPrincipal(admin, {
        kind: "agent",
        name: "Worker",
        owner: init.principal.id,
      });
      const agentToken = board.createToken(admin, {
        principalId: agent.id,
        scopes: ["tasks:read", "tasks:write", "tasks:approve"],
      }).secret!;
      const actor = board.verifyToken(agentToken);
      const project = board.createProject(admin, {
        key: "AP",
        name: "Approvals",
        settings: { approvalRequired: ["in_review->done"] },
      });
      const pending = () => {
        let task = board.createTask(admin, {
          projectId: project.id,
          title: "Review",
          accountable: init.principal.id,
        });
        task = board.transition(
          actor,
          task.id,
          { to: "in_progress" },
          { expectedVersion: task.version },
        ).task;
        task = board.transition(
          actor,
          task.id,
          { to: "in_review" },
          { expectedVersion: task.version },
        ).task;
        return board.transition(
          actor,
          task.id,
          { to: "done" },
          { expectedVersion: task.version },
        );
      };
      const approve = pending();
      const reject = pending();
      expect(
        json(
          directory,
          [
            "approvals",
            "list",
            "--project",
            project.id,
            "--state",
            "pending",
            "--limit",
            "10",
          ],
          init.secret,
        ).items,
      ).toHaveLength(2);
      const approveArgs = [
        "approvals",
        "approve",
        approve.approval!.id,
        "--expected-version",
        String(approve.task.version),
        "--idempotency-key",
        "approve",
      ];
      const denied = cli(directory, approveArgs, agentToken);
      expect(denied.status).toBe(1);
      expect(denied.stderr).toContain("Only humans");
      const approved = json(directory, approveArgs, init.secret);
      expect(approved.task.status).toBe("done");
      expect(approved.approval.decidedBy).toBe(init.principal.id);
      expect(json(directory, approveArgs, init.secret)).toEqual(approved);
      const rejected = json(
        directory,
        [
          "approvals",
          "reject",
          reject.approval!.id,
          "--expected-version",
          String(reject.task.version),
        ],
        init.secret,
      );
      expect(rejected.task.status).toBe("in_review");
      expect(rejected.approval.state).toBe("rejected");
      expect(
        json(
          directory,
          ["approvals", "list", "--state", "pending", "--limit", "10"],
          init.secret,
        ).items,
      ).toEqual([]);
    } finally {
      board.close();
    }
  });

  it("requires a port, honors config or flags, and serves the API on the default host", async () => {
    const directory = temporaryDirectory();
    json(directory, ["init", "--name", "Human"]);
    const missing = cli(directory, ["serve"]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("pass --port or set port");
    const verify = async (url: string) => {
      expect(new URL(url).hostname).toBe("127.0.0.1");
      const response = await fetch(`${url}/v1/openapi.json`);
      expect(response.status).toBe(200);
      expect((await response.json()).openapi).toBe("3.1.0");
    };
    await serving(directory, ["--port", "0"], verify);
    writeFileSync(join(directory, "config.json"), JSON.stringify({ port: 0 }));
    await serving(directory, [], verify);
    writeFileSync(
      join(directory, "config.json"),
      JSON.stringify({ port: 0, maxPageSize: 1 }),
    );
    await serving(directory, ["--port", "0", "--host", "127.0.0.1"], verify);
  });
});
