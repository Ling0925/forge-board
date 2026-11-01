import { describe, expect, it } from "vitest";
import { expectCode, fixture } from "./helpers.js";

describe("human approvals", () => {
  it.each(["in_progress->done", "*->done"] as const)(
    "saves progress with the %s request and preserves it on approval",
    (rule) => {
      const { board, admin, agent, repo, task } = fixture({
        approvalRequired: [rule],
      });
      const item = board.claim(agent, task().id).task;
      const before = repo.events(0).at(-1)!.seq;
      const pending = board.transition(
        agent,
        item.id,
        { to: "done", message: "Shipped", progress: "Ready for approval" },
        { leaseToken: item.lease!.token },
      );
      expect(pending.task).toEqual({
        ...item,
        progress: "Ready for approval",
        version: item.version + 1,
      });
      expect(board.getTask(admin, item.id)).toEqual(pending.task);
      expect(repo.events(before).map((event) => event.type)).toEqual([
        "approval_requested",
      ]);
      const approved = board.decideApproval(
        admin,
        pending.approval!.id,
        "approved",
        { expectedVersion: pending.task.version },
      );
      expect(approved.task).toMatchObject({
        status: "done",
        statusMessage: "Shipped",
        progress: "Ready for approval",
        version: pending.task.version + 1,
        lease: null,
      });
    },
  );

  it("invalidates a pending approval when only progress changes", () => {
    const { board, admin, agent, task } = fixture({
      approvalRequired: ["*->done"],
    });
    const item = board.claim(agent, task().id).task;
    const pending = board.transition(
      agent,
      item.id,
      { to: "done", progress: "Ready" },
      { leaseToken: item.lease!.token },
    );
    const updated = board.updateTask(
      agent,
      item.id,
      { progress: "New progress" },
      { leaseToken: item.lease!.token },
    );
    expectCode(
      () =>
        board.decideApproval(admin, pending.approval!.id, "approved", {
          expectedVersion: updated.version,
        }),
      "version_mismatch",
    );
  });

  it("still gates agent cancellation when allowAgentCancel is enabled", () => {
    const { board, admin, agent, task } = fixture({
      allowAgentCancel: true,
      approvalRequired: ["*->canceled"],
    });
    const item = board.claim(agent, task().id).task;
    const pending = board.transition(
      agent,
      item.id,
      { to: "canceled", progress: "Stopping" },
      { leaseToken: item.lease!.token },
    );
    expect(pending.task).toMatchObject({
      status: "in_progress",
      progress: "Stopping",
    });
    expect(pending.approval?.state).toBe("pending");
    expect(
      board.decideApproval(admin, pending.approval!.id, "approved", {
        expectedVersion: pending.task.version,
      }).task,
    ).toMatchObject({ status: "canceled", progress: "Stopping" });
  });

  it("invalidates a pending approval when its task lease expires", () => {
    const { board, admin, agent, task, advance } = fixture({
      leaseTtl: 1000,
      approvalRequired: ["in_review->done"],
    });
    let item = board.claim(agent, task().id).task;
    item = board.transition(
      agent,
      item.id,
      { to: "in_review" },
      { leaseToken: item.lease!.token },
    ).task;
    const pending = board.transition(
      agent,
      item.id,
      { to: "done" },
      { leaseToken: item.lease!.token },
    );
    advance(1000);
    expectCode(
      () =>
        board.decideApproval(admin, pending.approval!.id, "approved", {
          expectedVersion: pending.task.version,
        }),
      "version_mismatch",
    );
    expect(board.getTask(admin, item.id)).toMatchObject({
      status: "todo",
      lease: null,
    });
    expect(
      board.listApprovals(admin, item.id, { limit: 100 }).items[0]?.state,
    ).toBe("pending");
  });
  it("creates pending approval instead of transitioning and applies the decision atomically", () => {
    const { board, admin, agent, owner, task } = fixture({
      approvalRequired: ["in_review->done"],
    });
    let item = board.claim(agent, task().id).task;
    item = board.transition(
      agent,
      item.id,
      { to: "in_review" },
      { leaseToken: item.lease!.token },
    ).task;
    const pending = board.transition(
      agent,
      item.id,
      { to: "done", message: "Shipped" },
      { leaseToken: item.lease!.token },
    );
    expect(pending.task.status).toBe("in_review");
    expect(pending.approval).toMatchObject({
      state: "pending",
      requestedBy: agent.principal.id,
      taskVersion: pending.task.version,
    });
    expectCode(
      () =>
        board.decideApproval(agent, pending.approval!.id, "approved", {
          expectedVersion: pending.task.version,
          leaseToken: item.lease!.token,
        }),
      "forbidden",
    );
    expectCode(
      () =>
        board.decideApproval(
          { ...owner, scopes: ["tasks:write"] },
          pending.approval!.id,
          "approved",
          { expectedVersion: pending.task.version },
        ),
      "forbidden",
    );
    const mutation = {
      expectedVersion: pending.task.version,
      idempotencyKey: "approval",
    };
    const decided = board.decideApproval(
      owner,
      pending.approval!.id,
      "approved",
      mutation,
    );
    expect(decided.task).toMatchObject({
      status: "done",
      statusMessage: "Shipped",
      lease: null,
    });
    expect(decided.approval).toMatchObject({
      state: "approved",
      decidedBy: owner.principal.id,
    });
    expect(
      board.decideApproval(owner, pending.approval!.id, "approved", mutation),
    ).toEqual(decided);
    expect(board.listApprovals(admin, item.id, { limit: 100 }).items).toEqual([
      decided.approval,
    ]);
    expectCode(
      () =>
        board.decideApproval(owner, pending.approval!.id, "approved", {
          expectedVersion: decided.task.version,
        }),
      "conflict",
    );
  });

  it("rejects a request without applying its transition", () => {
    const { board, admin, task } = fixture({
      approvalRequired: ["*->canceled"],
    });
    const item = task();
    const requested = board.transition(
      admin,
      item.id,
      { to: "canceled", progress: "Stopping" },
      { expectedVersion: item.version },
    );
    const result = board.decideApproval(
      admin,
      requested.approval!.id,
      "rejected",
      { expectedVersion: requested.task.version },
    );
    expect(result.task.status).toBe("todo");
    expect(result.task.progress).toBe("Stopping");
    expect(result.approval?.state).toBe("rejected");
  });

  it("allows an agent to request gated cancellation while a human applies it", () => {
    const { board, admin, agent, task } = fixture({
      approvalRequired: ["*->canceled"],
    });
    const item = board.claim(agent, task().id).task;
    const requested = board.transition(
      agent,
      item.id,
      { to: "canceled" },
      { leaseToken: item.lease!.token },
    );
    expect(requested.task.status).toBe("in_progress");
    expect(
      board.decideApproval(admin, requested.approval!.id, "approved", {
        expectedVersion: requested.task.version,
      }).task.status,
    ).toBe("canceled");
  });

  it("checks both the caller version and the approval's captured task version", () => {
    const { board, admin, task } = fixture({
      approvalRequired: ["*->canceled"],
    });
    const item = task();
    const pending = board.transition(
      admin,
      item.id,
      { to: "canceled" },
      { expectedVersion: item.version },
    );
    expectCode(
      () =>
        board.decideApproval(admin, pending.approval!.id, "approved", {
          expectedVersion: item.version,
        }),
      "version_mismatch",
    );
    const changed = board.updateTask(
      admin,
      item.id,
      { title: "New context" },
      { expectedVersion: pending.task.version },
    );
    expectCode(
      () =>
        board.decideApproval(admin, pending.approval!.id, "approved", {
          expectedVersion: changed.version,
        }),
      "version_mismatch",
    );
    expect(
      board.listApprovals(admin, item.id, { limit: 100 }).items[0]?.state,
    ).toBe("pending");
    expect(board.getTask(admin, item.id).status).toBe("todo");
    expect(
      board.decideApproval(admin, pending.approval!.id, "rejected", {
        expectedVersion: changed.version,
      }).approval?.state,
    ).toBe("rejected");
  });

  it("gates claims and creates the requested agent's lease only upon approval", () => {
    const { board, admin, agent, task } = fixture({
      approvalRequired: ["todo->in_progress"],
    });
    const item = task();
    const pending = board.claim(agent, item.id);
    expect(pending.task).toMatchObject({ status: "todo", lease: null });
    const result = board.decideApproval(
      admin,
      pending.approval!.id,
      "approved",
      { expectedVersion: pending.task.version },
    );
    expect(result.task).toMatchObject({
      status: "in_progress",
      assignee: agent.principal.id,
      lease: { holder: agent.principal.id },
    });
  });

  it("does not let release bypass a configured transition gate", () => {
    const { board, admin, agent, task } = fixture({
      approvalRequired: ["in_progress->todo"],
    });
    const item = board.claim(agent, task().id).task;
    const pending = board.release(agent, item.id, {
      leaseToken: item.lease!.token,
    });
    expect(pending.task.lease).not.toBeNull();
    expect(
      board.decideApproval(admin, pending.approval!.id, "approved", {
        expectedVersion: pending.task.version,
      }).task,
    ).toMatchObject({ status: "todo", lease: null });
  });
});
