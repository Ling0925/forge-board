import { describe, expect, it } from "vitest";
import { expectCode, fixture } from "./helpers.js";

describe("idempotency", () => {
  it("replays the original response without repeated writes/events, independent of object key order", () => {
    const { board, repo, admin, owner, project } = fixture();
    const input = {
      projectId: project.id,
      accountable: owner.principal.id,
      title: "Once",
      metadata: { a: 1, b: 2 },
    };
    const mutation = { idempotencyKey: "create" };
    const created = board.createTask(admin, input, mutation);
    const events = repo.events(0);
    expect(
      board.createTask(admin, { ...input, metadata: { b: 2, a: 1 } }, mutation),
    ).toEqual(created);
    expect(repo.events(0)).toEqual(events);
    expect(board.listTasks(admin, { limit: 100 }).items).toHaveLength(1);
  });

  it("detects body, operation, version, and lease-token mismatch under the same key", () => {
    const { board, admin, agent, task } = fixture();
    const item = task();
    board.updateTask(
      admin,
      item.id,
      { title: "First" },
      { expectedVersion: item.version, idempotencyKey: "write" },
    );
    expectCode(
      () =>
        board.updateTask(
          admin,
          item.id,
          { title: "Different" },
          { expectedVersion: item.version, idempotencyKey: "write" },
        ),
      "idempotency_mismatch",
    );
    expectCode(
      () =>
        board.updateTask(
          admin,
          item.id,
          { title: "First" },
          { expectedVersion: item.version + 1, idempotencyKey: "write" },
        ),
      "idempotency_mismatch",
    );
    expectCode(
      () => board.claim(admin, item.id, { idempotencyKey: "write" }),
      "idempotency_mismatch",
    );
    const claimed = board.claim(agent, item.id).task;
    board.updateTask(
      agent,
      item.id,
      { progress: "same" },
      { leaseToken: claimed.lease!.token, idempotencyKey: "progress" },
    );
    expectCode(
      () =>
        board.updateTask(
          agent,
          item.id,
          { progress: "same" },
          { leaseToken: "old", idempotencyKey: "progress" },
        ),
      "idempotency_mismatch",
    );
  });

  it("keeps records indefinitely by default and keys them by principal", () => {
    const { board, admin, owner, project, advance } = fixture();
    const input = {
      projectId: project.id,
      accountable: owner.principal.id,
      title: "Retained",
    };
    const original = board.createTask(admin, input, { idempotencyKey: "same" });
    advance(1000 * 60 * 60 * 24 * 365);
    expect(board.createTask(admin, input, { idempotencyKey: "same" })).toEqual(
      original,
    );
    expect(
      board.createTask(owner, input, { idempotencyKey: "same" }).id,
    ).not.toBe(original.id);
  });

  it("prunes only when configured, lazily on write", () => {
    const { board, repo, admin, owner, project, advance } = fixture(
      {},
      { idempotencyRetention: 1000 },
    );
    const input = {
      projectId: project.id,
      accountable: owner.principal.id,
      title: "Pruned",
    };
    const first = board.createTask(admin, input, {
      idempotencyKey: "retention",
    });
    advance(999);
    expect(
      board.createTask(admin, input, { idempotencyKey: "retention" }),
    ).toEqual(first);
    advance(1);
    board.getTask(admin, first.id);
    expect(repo.replay(admin.principal.id, "retention")).toBeDefined();
    const second = board.createTask(admin, input, {
      idempotencyKey: "retention",
    });
    expect(second.id).not.toBe(first.id);
    expect(repo.replay(admin.principal.id, "retention")?.response).toContain(
      second.id,
    );
  });

  it("returns the original mutation response even after the task has changed", () => {
    const { board, admin, task } = fixture();
    const initial = task();
    const mutation = {
      expectedVersion: initial.version,
      idempotencyKey: "patch",
    };
    const first = board.updateTask(
      admin,
      initial.id,
      { title: "First" },
      mutation,
    );
    board.updateTask(
      admin,
      initial.id,
      { title: "Second" },
      { expectedVersion: first.version },
    );
    expect(
      board.updateTask(admin, initial.id, { title: "First" }, mutation),
    ).toEqual(first);
  });

  it("does not let a narrower token replay another project's result", () => {
    const { board, admin, owner, project } = fixture();
    const input = {
      projectId: project.id,
      accountable: owner.principal.id,
      title: "Private",
    };
    board.createTask(admin, input, { idempotencyKey: "private" });
    expectCode(
      () =>
        board.createTask({ ...admin, projectIds: [] }, input, {
          idempotencyKey: "private",
        }),
      "forbidden",
    );
    const projectInput = { key: "SECOND", name: "Second" };
    board.createProject(admin, projectInput, { idempotencyKey: "project" });
    expectCode(
      () =>
        board.createProject(
          { ...admin, projectIds: [project.id] },
          projectInput,
          { idempotencyKey: "project" },
        ),
      "forbidden",
    );
  });

  it("does not retain failed mutations or their partial changes", () => {
    const { board, repo, admin, task } = fixture();
    const initial = task();
    const item = board.transition(
      admin,
      initial.id,
      { to: "canceled" },
      { expectedVersion: initial.version },
    ).task;
    const events = repo.events(0);
    expectCode(
      () =>
        board.addComment(
          admin,
          item.id,
          { kind: "question", body: "Invalid transition" },
          { expectedVersion: item.version, idempotencyKey: "failed" },
        ),
      "invalid_transition",
    );
    expect(board.listComments(admin, item.id, { limit: 100 }).items).toEqual(
      [],
    );
    expect(repo.events(0)).toEqual(events);
    expect(repo.replay(admin.principal.id, "failed")).toBeUndefined();
  });
});
