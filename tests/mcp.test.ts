import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/http/index.js";
import { fixture } from "./helpers.js";
import { call, connectMcp, serveBoard, toolData } from "./transport-helpers.js";

describe("MCP Streamable HTTP", () => {
  it("advertises zod schemas and preserves service validation, idempotency, versions, claims and related pages", async () => {
    const f = fixture({}, { maxPageSize: 1 });
    const token = f.board.createToken(f.admin, {
      principalId: f.agent.principal.id,
      scopes: f.agent.scopes,
    }).secret!;
    const server = await serveBoard(f.board);
    const client = await connectMcp(server.url, token);
    try {
      const tools = (await client.listTools()).tools;
      expect(tools.map((tool) => tool.name).sort()).toEqual(
        [
          "board_list",
          "board_get",
          "board_create",
          "board_update",
          "board_claim",
          "board_release",
          "board_transition",
          "board_comment",
          "board_artifact",
          "board_link",
        ].sort(),
      );
      for (const tool of tools) {
        expect(tool.inputSchema.type).toBe("object");
        if (!["board_list", "board_get"].includes(tool.name))
          expect(tool.inputSchema.properties).toHaveProperty("idempotencyKey");
      }
      const input = {
        projectId: f.project.id,
        accountable: f.owner.principal.id,
        title: "MCP",
        priority: 1,
        subtasks: [{ title: "Child" }],
        idempotencyKey: "create",
      };
      const task = await call(client, "board_create", input);
      expect(await call(client, "board_create", input)).toEqual(task);
      const mismatch = await client.callTool({
        name: "board_create",
        arguments: { ...input, title: "Other" },
      });
      expect(mismatch.isError).toBe(true);
      expect(toolData(mismatch as CallToolResult).error.code).toBe(
        "idempotency_mismatch",
      );
      const page = await call(client, "board_list", { ready: true, limit: 10 });
      expect(page.items).toHaveLength(1);
      const second = await call(client, "board_list", {
        ready: true,
        limit: 10,
        cursor: page.nextCursor,
      });
      expect(second.items[0].parentId).toBe(task.id);
      const claim = await call(client, "board_claim", {
        next: true,
        projectId: f.project.id,
        idempotencyKey: "claim",
      });
      expect(claim.task.id).toBe(task.id);
      expect(
        await call(client, "board_claim", {
          next: true,
          projectId: f.project.id,
          idempotencyKey: "claim",
        }),
      ).toEqual(claim);
      const leaseToken = claim.task.lease.token;
      const updated = await call(client, "board_update", {
        id: task.id,
        progress: "Working",
        leaseToken,
        idempotencyKey: "progress",
      });
      expect(updated.progress).toBe("Working");
      const conflict = await client.callTool({
        name: "board_update",
        arguments: {
          id: task.id,
          title: "Stale",
          expectedVersion: task.version,
          leaseToken,
        },
      });
      expect(conflict.isError).toBe(true);
      expect(toolData(conflict as CallToolResult).error).toMatchObject({
        code: "version_mismatch",
        status: 412,
        details: { currentTask: updated },
      });
      const linked = await call(client, "board_link", {
        id: task.id,
        kind: "thread",
        ref: "thread:mcp",
        expectedVersion: updated.version,
        leaseToken,
      });
      const detail = await call(client, "board_get", {
        id: task.id,
        links: { limit: 10 },
        comments: { limit: 10 },
        artifacts: { limit: 10 },
        approvals: { limit: 10 },
        dependencies: { limit: 10 },
        events: { limit: 10 },
      });
      expect(detail.task).toEqual(linked.task);
      expect(detail.links.items).toEqual([linked.link]);
      expect(detail.comments.items).toEqual([]);
      expect(detail.events.items).toHaveLength(1);
      const released = await call(client, "board_release", {
        id: task.id,
        leaseToken,
      });
      expect(released.task).toMatchObject({ status: "todo", lease: null });
      for (const args of [
        {},
        { id: task.id, next: true, projectId: f.project.id },
        { next: true },
      ])
        expect(
          (await client.callTool({ name: "board_claim", arguments: args }))
            .isError,
        ).toBe(true);
      expect(
        (await client.callTool({ name: "board_list", arguments: { limit: 0 } }))
          .isError,
      ).toBe(true);
      expect(
        (
          await client.callTool({
            name: "board_create",
            arguments: { ...input, unexpected: true },
          })
        ).isError,
      ).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("authenticates each request and enforces token scopes and project scope", async () => {
    const f = fixture();
    const app = createApp(f.board);
    expect((await app.request("/mcp", { method: "POST" })).status).toBe(401);
    const readonly = f.board.createToken(f.admin, {
      principalId: f.agent.principal.id,
      scopes: ["tasks:read"],
      projectIds: [f.project.id],
    });
    const other = f.board.createProject(f.admin, {
      key: "PRIVATE",
      name: "Private",
    });
    const task = f.task();
    const server = await serveBoard(f.board);
    const client = await connectMcp(server.url, readonly.secret!);
    try {
      expect((await call(client, "board_get", { id: task.id })).task.id).toBe(
        task.id,
      );
      for (const request of [
        { name: "board_claim", arguments: { id: task.id } },
        { name: "board_list", arguments: { projectId: other.id, limit: 10 } },
      ]) {
        const result = await client.callTool(request);
        expect(result.isError).toBe(true);
        expect(toolData(result as CallToolResult).error.code).toBe("forbidden");
      }
      f.board.revokeToken(f.admin, readonly.token.id);
      await expect(client.listTools()).rejects.toMatchObject({ code: 401 });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
