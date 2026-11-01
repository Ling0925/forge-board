import { once } from "node:events";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/http/index.js";
import { fixture } from "./helpers.js";
import { subscribe } from "./transport-helpers.js";

async function withServer(
  run: (
    f: ReturnType<typeof fixture>,
    url: string,
    secret: string,
  ) => Promise<void>,
  settings: Parameters<typeof fixture>[0] = {},
) {
  const f = fixture(settings);
  const secret = f.board.createToken(f.admin, {
    principalId: f.admin.principal.id,
    scopes: f.admin.scopes,
  }).secret!;
  const server = serve({
    fetch: createApp(f.board).fetch,
    hostname: "127.0.0.1",
    port: 0,
  }) as Server;
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected TCP server");
  try {
    await run(f, `http://127.0.0.1:${address.port}/v1`, secret);
  } finally {
    const closed = new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    server.closeAllConnections();
    await closed;
  }
}

describe("SSE and commit notifications", () => {
  it("notifies only committed changes, including observed expiry after a rejected write", () => {
    const f = fixture({ leaseTtl: 1000 });
    const notify = vi.fn(() => {
      expect(f.db.isTransaction).toBe(false);
    });
    const stop = f.board.onCommit(notify);
    const task = f.task();
    expect(notify).toHaveBeenCalledTimes(1);
    f.board.getTask(f.admin, task.id);
    expect(notify).toHaveBeenCalledTimes(1);
    f.board.updateTask(
      f.admin,
      task.id,
      { title: "Updated" },
      { expectedVersion: task.version, idempotencyKey: "once" },
    );
    f.board.updateTask(
      f.admin,
      task.id,
      { title: "Updated" },
      { expectedVersion: task.version, idempotencyKey: "once" },
    );
    expect(notify).toHaveBeenCalledTimes(2);
    const canceled = f.board.transition(
      f.admin,
      task.id,
      { to: "canceled" },
      { expectedVersion: task.version + 1 },
    ).task;
    expect(() =>
      f.board.addComment(
        f.admin,
        task.id,
        { kind: "question", body: "Rollback" },
        { expectedVersion: canceled.version },
      ),
    ).toThrow();
    expect(notify).toHaveBeenCalledTimes(3);
    const leased = f.board.claim(f.agent, f.task().id).task;
    const before = notify.mock.calls.length;
    f.advance(1000);
    expect(() =>
      f.board.updateTask(
        f.agent,
        leased.id,
        { progress: "Expired" },
        { leaseToken: leased.lease!.token },
      ),
    ).toThrow();
    expect(notify).toHaveBeenCalledTimes(before + 1);
    expect(f.repo.events(0).at(-1)?.type).toBe("lease_expired");
    stop();
    f.task();
    expect(notify).toHaveBeenCalledTimes(before + 1);
  });

  it("replays in sequence, streams service commits, and resumes with Last-Event-ID taking precedence", async () => {
    await withServer(async (f, url, secret) => {
      const first = f.task("First");
      const initial = f.repo
        .events(0)
        .filter((e) => e.projectId === f.project.id);
      const stream = await subscribe(
        `${url}/events?project=${f.project.id}`,
        secret,
      );
      try {
        f.task("During replay");
        for (const expected of initial)
          expect(await stream.next()).toEqual(expected);
        const live = await stream.next();
        expect(live.type).toBe("task_created");
        expect(live.seq).toBeGreaterThan(initial.at(-1)!.seq);
        f.board.updateTask(
          f.admin,
          first.id,
          { title: "Changed" },
          { expectedVersion: first.version },
        );
        const updated = await stream.next();
        expect(updated.type).toBe("task_updated");
        expect(updated.seq).toBeGreaterThan(live.seq);
        const resumed = await subscribe(
          `${url}/events?project=${f.project.id}&after=0`,
          secret,
          { "Last-Event-ID": String(live.seq) },
        );
        try {
          expect(await resumed.next()).toEqual(updated);
          f.task("Later");
          const later = await resumed.next();
          expect(later.seq).toBeGreaterThan(updated.seq);
          expect(await stream.next()).toEqual(later);
        } finally {
          resumed.close();
        }
      } finally {
        stream.close();
      }
    });
  });

  it("filters replay and new events by project and task, with JSON cursor pages for polling", async () => {
    await withServer(async (f, url, secret) => {
      const target = f.task("Target");
      const other = f.task("Other");
      const project = f.board.createProject(f.admin, {
        key: "OTHER",
        name: "Other",
      });
      f.board.createTask(f.admin, {
        projectId: project.id,
        title: "Elsewhere",
        accountable: f.owner.principal.id,
      });
      const expected = f.repo.events(0).filter((e) => e.taskId === target.id);
      const stream = await subscribe(
        `${url}/events?project=${f.project.id}&task=${target.id}&after=0`,
        secret,
      );
      try {
        for (const event of expected)
          expect(await stream.next()).toEqual(event);
        f.board.updateTask(
          f.admin,
          other.id,
          { progress: "Ignore" },
          { expectedVersion: other.version },
        );
        f.board.updateTask(
          f.admin,
          target.id,
          { progress: "Send" },
          { expectedVersion: target.version },
        );
        const live = await stream.next();
        expect(live.taskId).toBe(target.id);
        const replay = await subscribe(
          `${url}/events?task=${target.id}&after=${expected.at(-1)!.seq}`,
          secret,
        );
        try {
          expect(await replay.next()).toEqual(live);
        } finally {
          replay.close();
        }
        const headers = { Authorization: `Bearer ${secret}` };
        const page = await (
          await fetch(`${url}/events?task=${target.id}&limit=1`, { headers })
        ).json();
        expect(page.items).toEqual(expected);
        expect(page.nextCursor).toBe(String(expected[0]!.seq));
        const next = await (
          await fetch(
            `${url}/events?task=${target.id}&limit=1&cursor=${page.nextCursor}`,
            { headers },
          )
        ).json();
        expect(next).toEqual({ items: [live], nextCursor: null });
      } finally {
        stream.close();
      }
    });
  });

  it("enforces scope filters before opening a stream and delivers lazy expiry", async () => {
    await withServer(
      async (f, url, secret) => {
        const scoped = f.board.createToken(f.admin, {
          principalId: f.agent.principal.id,
          scopes: ["tasks:read"],
          projectIds: [],
        }).secret!;
        const denied = await fetch(`${url}/events?project=${f.project.id}`, {
          headers: {
            Authorization: `Bearer ${scoped}`,
            Accept: "text/event-stream",
          },
        });
        expect(denied.status).toBe(403);
        const task = f.board.claim(f.agent, f.task().id).task;
        const after = f.repo.events(0).at(-1)!.seq;
        const stream = await subscribe(
          `${url}/events?task=${task.id}&after=${after}`,
          secret,
        );
        try {
          f.advance(1000);
          f.board.getTask(f.admin, task.id);
          expect((await stream.next()).type).toBe("lease_expired");
        } finally {
          stream.close();
        }
      },
      { leaseTtl: 1000 },
    );
  });
});
