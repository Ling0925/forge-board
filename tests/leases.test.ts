import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBoard } from "../src/service/index.js";
import { openDatabase } from "../src/store/index.js";
import { expectCode, fixture } from "./helpers.js";

describe("claims, leases, and versions", () => {
  it("uses current project TTL settings when renewing", () => {
    const { board, admin, agent, project, task, advance } = fixture({
      leaseTtl: 1000,
    });
    const item = board.claim(agent, task().id).task;
    board.updateProject(admin, project.id, { settings: {} });
    const renewed = board.renewLease(agent, item.id, {
      leaseToken: item.lease!.token,
    });
    expect(renewed.lease?.expiresAt).toBeNull();
    advance(2000);
    expect(board.getTask(admin, item.id).lease).toEqual(renewed.lease);
  });
  it("gives two competing claimers on separate connections exactly one winner", async () => {
    const { board, directory, agent, peer, task, now, admin } = fixture({}, {});
    const item = task();
    const otherDb = openDatabase(join(directory!, "board.sqlite"));
    const otherBoard = createBoard({ db: otherDb, now });
    try {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => board.claim(agent, item.id)),
        Promise.resolve().then(() => otherBoard.claim(peer, item.id)),
      ]);
      const won = results.filter((result) => result.status === "fulfilled");
      const lost = results.filter((result) => result.status === "rejected");
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(lost[0]).toMatchObject({
        reason: {
          code: "claim_conflict",
          status: 409,
          details: { holder: agent.principal.id },
        },
      });
      expect(board.getTask(admin, item.id).lease?.holder).toBe(
        agent.principal.id,
      );
      expect(
        board
          .listEvents(admin, { limit: 100, taskId: item.id })
          .items.filter((event) => event.type === "task_claimed"),
      ).toHaveLength(1);
    } finally {
      otherDb.close();
    }
  });

  it("holds indefinitely by default until released", () => {
    const { board, agent, peer, task, advance } = fixture();
    const item = task();
    const claimed = board.claim(agent, item.id).task;
    expect(claimed.lease?.expiresAt).toBeNull();
    advance(1000 * 60 * 60 * 24 * 365);
    expect(board.getTask(peer, item.id).lease).toEqual(claimed.lease);
    expectCode(() => board.claim(peer, item.id), "claim_conflict");
    const released = board.release(agent, item.id, {
      leaseToken: claimed.lease!.token,
    }).task;
    expect(released).toMatchObject({ status: "todo", lease: null });
    expect(board.claim(peer, item.id).task.lease?.holder).toBe(
      peer.principal.id,
    );
  });

  it("expires lazily at the exact TTL boundary and emits one event on observation", () => {
    const { board, repo, agent, peer, task, advance, admin, now } = fixture({
      leaseTtl: 1000,
    });
    const item = task();
    const claimed = board.claim(agent, item.id).task;
    expect(claimed.lease?.expiresAt).toBe(new Date(now() + 1000).toISOString());
    advance(1000);
    expect(repo.get("tasks", item.id)?.lease).toEqual(claimed.lease);
    expect(
      repo.events(0).filter((event) => event.type === "lease_expired"),
    ).toEqual([]);
    const expired = board.getTask(peer, item.id);
    expect(expired).toMatchObject({
      status: "todo",
      lease: null,
      version: claimed.version + 1,
    });
    board.getTask(peer, item.id);
    expect(
      board
        .listEvents(admin, { limit: 100, taskId: item.id })
        .items.filter((event) => event.type === "lease_expired"),
    ).toMatchObject([
      { actor: peer.principal.id, owner: peer.principal.owner },
    ]);
  });

  it("observes expiry during claim and preserves the expiry event after a rejected stale write", () => {
    const { board, repo, agent, peer, task, advance } = fixture({
      leaseTtl: 1000,
    });
    const item = task();
    const lease = board.claim(agent, item.id).task.lease!;
    advance(1000);
    expectCode(
      () =>
        board.updateTask(
          agent,
          item.id,
          { progress: "late" },
          { leaseToken: lease.token },
        ),
      "lease_lost",
    );
    expect(repo.get("tasks", item.id)?.status).toBe("todo");
    expect(
      repo.events(0).filter((event) => event.type === "lease_expired"),
    ).toHaveLength(1);
    const current = board.claim(peer, item.id).task;
    expectCode(
      () =>
        board.addComment(
          agent,
          item.id,
          { kind: "comment", body: "late" },
          { expectedVersion: current.version, leaseToken: lease.token },
        ),
      "lease_lost",
    );
    advance(1000);
    expect(board.claim(agent, item.id).task.lease?.holder).toBe(
      agent.principal.id,
    );
    expect(
      repo.events(0).filter((event) => event.type === "lease_expired"),
    ).toHaveLength(2);
  });

  it("renews TTL on holder writes and explicit renewal, without changing a nonholder's lease", () => {
    const { board, agent, owner, task, advance, now } = fixture({
      leaseTtl: 1000,
    });
    let item = board.claim(agent, task().id).task;
    const token = item.lease!.token;
    advance(100);
    item = board.updateTask(
      agent,
      item.id,
      { progress: "working" },
      { leaseToken: token },
    );
    expect(item.lease?.expiresAt).toBe(new Date(now() + 1000).toISOString());
    advance(100);
    item = board.addComment(
      agent,
      item.id,
      { kind: "comment", body: "status" },
      { leaseToken: token, expectedVersion: item.version },
    ).task;
    expect(item.lease?.expiresAt).toBe(new Date(now() + 1000).toISOString());
    const expiresAt = item.lease!.expiresAt;
    advance(100);
    item = board.addComment(
      owner,
      item.id,
      { kind: "comment", body: "feedback" },
      { expectedVersion: item.version },
    ).task;
    expect(item.lease?.expiresAt).toBe(expiresAt);
    item = board.renewLease(agent, item.id, { leaseToken: token });
    expect(item.lease?.expiresAt).toBe(new Date(now() + 1000).toISOString());
  });

  it("allows explicit reclaim only by accountable human, holder owner, or human project administrator", () => {
    const { board, admin, owner, other, agent, peer, task } = fixture();
    let item = task();
    item = board.updateTask(
      admin,
      item.id,
      { accountable: other.principal.id },
      { expectedVersion: item.version },
    );
    item = board.claim(agent, item.id).task;
    expectCode(
      () => board.reclaim(peer, item.id, { expectedVersion: item.version }),
      "forbidden",
    );
    expectCode(
      () =>
        board.reclaim(
          { ...agent, scopes: [...agent.scopes, "projects:admin"] },
          item.id,
          { expectedVersion: item.version },
        ),
      "forbidden",
    );
    expect(
      board.reclaim(owner, item.id, { expectedVersion: item.version }).task
        .lease,
    ).toBeNull();
    item = board.claim(agent, item.id).task;
    expect(
      board.reclaim(other, item.id, { expectedVersion: item.version }).task
        .status,
    ).toBe("todo");
    item = board.claim(agent, item.id).task;
    expect(
      board.reclaim(admin, item.id, { expectedVersion: item.version }).task
        .lease,
    ).toBeNull();
  });

  it("denies an unrelated human and rejects an old token even after the same principal reclaims", () => {
    const { board, owner, other, agent, task } = fixture();
    const item = task();
    const original = board.claim(agent, item.id).task;
    expectCode(
      () =>
        board.reclaim(other, item.id, { expectedVersion: original.version }),
      "forbidden",
    );
    board.reclaim(owner, item.id, { expectedVersion: original.version });
    const next = board.claim(agent, item.id).task;
    expect(next.lease?.token).not.toBe(original.lease?.token);
    expectCode(
      () =>
        board.transition(
          agent,
          item.id,
          { to: "in_review" },
          { leaseToken: original.lease!.token, expectedVersion: next.version },
        ),
      "lease_lost",
    );
    expectCode(
      () =>
        board.release(agent, item.id, { leaseToken: original.lease!.token }),
      "lease_lost",
    );
    expectCode(
      () => board.renewLease(other, item.id, { leaseToken: next.lease!.token }),
      "lease_lost",
    );
  });

  it("uses 412 with the current task for missing or stale versions and limits the lease-holder exception to progress/transitions", () => {
    const { board, admin, agent, task } = fixture();
    const initial = task();
    expectCode(
      () => board.updateTask(admin, initial.id, { title: "missing" }),
      "version_mismatch",
    );
    const updated = board.updateTask(
      admin,
      initial.id,
      { title: "updated" },
      { expectedVersion: initial.version },
    );
    expect(() =>
      board.updateTask(
        admin,
        initial.id,
        { title: "stale" },
        { expectedVersion: initial.version },
      ),
    ).toThrowError(
      expect.objectContaining({
        status: 412,
        details: { currentTask: updated },
      }),
    );
    const claimed = board.claim(agent, initial.id).task;
    expectCode(
      () =>
        board.updateTask(
          agent,
          initial.id,
          { title: "no version" },
          { leaseToken: claimed.lease!.token },
        ),
      "version_mismatch",
    );
    expectCode(
      () =>
        board.updateTask(
          agent,
          initial.id,
          { progress: "no token" },
          { expectedVersion: claimed.version },
        ),
      "lease_lost",
    );
    expectCode(
      () =>
        board.updateTask(
          agent,
          initial.id,
          { progress: "stale" },
          {
            expectedVersion: initial.version,
            leaseToken: claimed.lease!.token,
          },
        ),
      "version_mismatch",
    );
    board.updateTask(
      agent,
      initial.id,
      { progress: "progress" },
      { leaseToken: claimed.lease!.token },
    );
    expect(
      board.transition(
        agent,
        initial.id,
        { to: "in_review" },
        { leaseToken: claimed.lease!.token },
      ).task.status,
    ).toBe("in_review");
  });

  it.each(["done", "failed", "canceled"] as const)(
    "clears the lease on %s and allows explicit reopen",
    (status) => {
      const { board, admin, agent, task } = fixture();
      let item = board.claim(agent, task().id).task;
      if (status === "done")
        item = board.transition(
          agent,
          item.id,
          { to: "in_review" },
          { leaseToken: item.lease!.token },
        ).task;
      item = board.transition(
        admin,
        item.id,
        { to: status },
        { expectedVersion: item.version },
      ).task;
      expect(item.lease).toBeNull();
      expect(
        board.transition(
          admin,
          item.id,
          { to: "todo" },
          { expectedVersion: item.version },
        ).task.status,
      ).toBe("todo");
    },
  );

  it("does not let agents cancel tasks", () => {
    const { board, agent, task } = fixture();
    const item = board.claim(agent, task().id).task;
    expectCode(
      () =>
        board.transition(
          agent,
          item.id,
          { to: "canceled" },
          { leaseToken: item.lease!.token },
        ),
      "forbidden",
    );
  });
});
