import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/http/index.js";
import { fixture } from "./helpers.js";
import { call, connectMcp, serveBoard, toolData } from "./transport-helpers.js";

describe("MCP Streamable HTTP", () => {
  it("exposes the authenticated identity without task scopes or token data", async () => {
    const f = fixture();
    const token = f.board.createToken(f.admin, {
      principalId: f.agent.principal.id,
      scopes: [],
      projectIds: [f.project.id],
    });
    const server = await serveBoard(f.board);
    const client = await connectMcp(server.url, token.secret!);
    try {
      expect(await call(client, "board_me", {})).toEqual({
        principal: f.agent.principal,
        scopes: [],
        projectIds: [f.project.id],
      });
      f.board.revokeToken(f.admin, token.token.id);
      await expect(
        client.callTool({ name: "board_me", arguments: {} }),
      ).rejects.toMatchObject({ code: 401 });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("transitions atomically with progress, including approval requests and configured cancellation", async () => {
    const f = fixture();
    const token = f.board.createToken(f.admin, {
      principalId: f.agent.principal.id,
      scopes: f.agent.scopes,
    }).secret!;
    const server = await serveBoard(f.board);
    const client = await connectMcp(server.url, token);
    try {
      const item = f.board.claim(f.agent, f.task().id).task;
      const before = f.repo.events(0).at(-1)!.seq;
      const done = await call(client, "board_transition", {
        id: item.id,
        to: "done",
        message: "Shipped",
        progress: "Complete",
        leaseToken: item.lease!.token,
      });
      expect(done.task).toMatchObject({
        status: "done",
        statusMessage: "Shipped",
        progress: "Complete",
        version: item.version + 1,
        lease: null,
      });
      expect(
        f.repo
          .events(before)
          .filter((event) => event.taskId !== null)
          .map((event) => event.type),
      ).toEqual(["task_transitioned"]);

      f.board.updateProject(f.admin, f.project.id, {
        settings: { approvalRequired: ["*->done"] },
      });
      const gated = f.board.claim(f.agent, f.task().id).task;
      const beforeApproval = f.repo.events(0).at(-1)!.seq;
      const pending = await call(client, "board_transition", {
        id: gated.id,
        to: "done",
        message: "Ready",
        progress: "Review this",
        leaseToken: gated.lease!.token,
      });
      expect(pending.task).toMatchObject({
        status: "in_progress",
        statusMessage: gated.statusMessage,
        progress: "Review this",
        version: gated.version + 1,
      });
      expect(
        f.repo
          .events(beforeApproval)
          .filter((event) => event.taskId !== null)
          .map((event) => event.type),
      ).toEqual(["approval_requested"]);
      expect(
        f.board.decideApproval(f.admin, pending.approval.id, "approved", {
          expectedVersion: pending.task.version,
        }).task,
      ).toMatchObject({
        status: "done",
        statusMessage: "Ready",
        progress: "Review this",
      });

      const cancel = f.board.claim(f.agent, f.task().id).task;
      const args = {
        id: cancel.id,
        to: "canceled",
        leaseToken: cancel.lease!.token,
      };
      const denied = await client.callTool({
        name: "board_transition",
        arguments: args,
      });
      expect(denied.isError).toBe(true);
      expect(toolData(denied as CallToolResult).error.code).toBe("forbidden");
      f.board.updateProject(f.admin, f.project.id, {
        settings: { allowAgentCancel: true },
      });
      expect((await call(client, "board_transition", args)).task.status).toBe(
        "canceled",
      );
      f.board.updateProject(f.admin, f.project.id, {
        settings: { allowAgentCancel: true, approvalRequired: ["*->canceled"] },
      });
      const gatedCancel = f.board.claim(f.agent, f.task().id).task;
      const requested = await call(client, "board_transition", {
        id: gatedCancel.id,
        to: "canceled",
        leaseToken: gatedCancel.lease!.token,
      });
      expect(requested.task.status).toBe("in_progress");
      expect(requested.approval.state).toBe("pending");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("supports duplicate links, all-link reads, status arrays and both unlink selectors", async () => {
    const f = fixture({}, { maxPageSize: 1 });
    const token = f.board.createToken(f.admin, {
      principalId: f.agent.principal.id,
      scopes: f.agent.scopes,
    }).secret!;
    const task = f.task("Linked");
    f.advance(1);
    const running = f.board.claim(f.agent, f.task("Running").id).task;
    const excluded = f.task("Canceled");
    f.board.transition(
      f.admin,
      excluded.id,
      { to: "canceled" },
      { expectedVersion: excluded.version },
    );
    const server = await serveBoard(f.board);
    const client = await connectMcp(server.url, token);
    try {
      const input = {
        id: task.id,
        kind: "thread",
        ref: "thread:mcp",
        title: "Original",
      };
      const linked = await call(client, "board_link", {
        ...input,
        expectedVersion: task.version,
      });
      const before = f.repo.events(0).filter((event) => event.taskId !== null);
      expect(
        await call(client, "board_link", {
          ...input,
          title: "Ignored",
          expectedVersion: linked.task.version,
        }),
      ).toEqual(linked);
      expect(f.repo.events(0).filter((event) => event.taskId !== null)).toEqual(
        before,
      );
      const second = await call(client, "board_link", {
        id: task.id,
        kind: "session",
        ref: input.ref,
        expectedVersion: linked.task.version,
      });
      const links = f.repo.list("links", "task_id = ?", [task.id]);
      expect(await call(client, "board_get", { id: task.id })).toEqual({
        task: second.task,
      });
      const detail = await call(client, "board_get", {
        id: task.id,
        include: "links",
        links: {},
      });
      expect(detail.task).toEqual({ ...second.task, links });
      expect(detail.links.items).toHaveLength(1);
      const query = {
        status: ["todo", "in_progress"],
        include: "links",
        limit: 1,
      };
      const first = await call(client, "board_list", query);
      expect(first.items).toEqual([{ ...second.task, links }]);
      expect(
        await call(client, "board_list", {
          ...query,
          cursor: first.nextCursor,
        }),
      ).toEqual({ items: [{ ...running, links: [] }], nextCursor: null });
      expect(
        (await call(client, "board_list", { status: "in_progress" })).items,
      ).toEqual([running]);
      const removed = await call(client, "board_unlink", {
        id: task.id,
        kind: input.kind,
        ref: input.ref,
        expectedVersion: second.task.version,
      });
      expect(removed.version).toBe(second.task.version + 1);
      const afterRemoval = f.repo
        .events(0)
        .filter((event) => event.taskId !== null);
      expect(
        await call(client, "board_unlink", {
          id: task.id,
          kind: input.kind,
          ref: input.ref,
          expectedVersion: removed.version,
        }),
      ).toEqual(removed);
      expect(f.repo.events(0).filter((event) => event.taskId !== null)).toEqual(
        afterRemoval,
      );
      const missing = await client.callTool({
        name: "board_unlink",
        arguments: {
          id: task.id,
          linkId: linked.link.id,
          expectedVersion: removed.version,
        },
      });
      expect(missing.isError).toBe(true);
      expect(toolData(missing as CallToolResult).error.code).toBe("not_found");
      const empty = await call(client, "board_unlink", {
        id: task.id,
        linkId: second.link.id,
        expectedVersion: removed.version,
      });
      expect(
        (await call(client, "board_get", { id: task.id, include: "links" }))
          .task,
      ).toEqual({ ...empty, links: [] });
      for (const args of [
        {},
        { kind: input.kind },
        { ref: input.ref },
        { linkId: second.link.id, kind: input.kind, ref: input.ref },
      ])
        expect(
          (
            await client.callTool({
              name: "board_unlink",
              arguments: {
                id: task.id,
                expectedVersion: empty.version,
                ...args,
              },
            })
          ).isError,
        ).toBe(true);
      for (const status of ["unknown", ["todo", "unknown"]])
        expect(
          (await client.callTool({ name: "board_list", arguments: { status } }))
            .isError,
        ).toBe(true);
      for (const name of ["board_get", "board_list"])
        expect(
          (
            await client.callTool({
              name,
              arguments: {
                ...(name === "board_get" ? { id: task.id } : {}),
                include: "unknown",
              },
            })
          ).isError,
        ).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it.each([undefined, 1])(
    "accepts omitted list and related collection limits with maxPageSize %s",
    async (maxPageSize) => {
      const f = fixture({}, { maxPageSize });
      const first = f.task("First");
      f.task("Second");
      const token = f.board.createToken(f.admin, {
        principalId: f.owner.principal.id,
        scopes: ["tasks:read"],
      }).secret!;
      const server = await serveBoard(f.board);
      const client = await connectMcp(server.url, token);
      try {
        const tool = (await client.listTools()).tools.find(
          (tool) => tool.name === "board_list",
        )!;
        expect(tool.inputSchema.required ?? []).not.toContain("limit");
        const page = await call(client, "board_list", {});
        expect(page.items).toHaveLength(maxPageSize ?? 2);
        expect(page).toEqual(await call(client, "board_list", { limit: 2 }));
        const detail = await call(client, "board_get", {
          id: first.id,
          comments: {},
          artifacts: {},
          links: {},
          dependencies: {},
          approvals: {},
          events: {},
        });
        for (const collection of [
          "comments",
          "artifacts",
          "links",
          "dependencies",
          "approvals",
        ])
          expect(detail[collection]).toEqual({ items: [], nextCursor: null });
        expect(detail.events.items).toHaveLength(1);
        if (maxPageSize !== undefined) {
          const last = await call(client, "board_list", {
            cursor: page.nextCursor,
          });
          expect(last.items).toHaveLength(1);
          expect(last.items[0].id).not.toBe(page.items[0].id);
          expect(last.nextCursor).toBeNull();
        } else {
          expect(page.nextCursor).toBeNull();
        }
      } finally {
        await client.close();
        await server.close();
      }
    },
  );

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
          "board_me",
          "board_get",
          "board_create",
          "board_update",
          "board_claim",
          "board_release",
          "board_transition",
          "board_comment",
          "board_artifact",
          "board_link",
          "board_unlink",
        ].sort(),
      );
      for (const tool of tools) {
        expect(tool.inputSchema.type).toBe("object");
        if (!["board_list", "board_get", "board_me"].includes(tool.name))
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
