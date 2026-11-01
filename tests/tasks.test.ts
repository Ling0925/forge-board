import { describe, expect, it } from "vitest";
import { expectCode, fixture } from "./helpers.js";

describe("task rules and graph", () => {
  it("creates sortable task IDs and per-project numbers with shared human/agent task fields", () => {
    const { board, admin, agent, owner, project, advance, task } = fixture();
    const first = task();
    advance(1);
    const second = board.createTask(agent, {
      projectId: project.id,
      accountable: owner.principal.id,
      title: "Agent task",
      authorization: "explicit",
      metadata: { forge: { thread: "thread-1" } },
    });
    expect(first.id).toMatch(/^tsk_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(second.id > first.id).toBe(true);
    expect([first.number, second.number]).toEqual([1, 2]);
    expect(second).toMatchObject({
      createdBy: agent.principal.id,
      authorization: "explicit",
      status: "todo",
      assignee: null,
      version: 1,
    });
    const other = board.createProject(admin, { key: "OTHER", name: "Other" });
    expect(
      board.createTask(admin, {
        projectId: other.id,
        accountable: owner.principal.id,
        title: "Independent",
      }).number,
    ).toBe(1);
    expectCode(
      () =>
        board.createTask(agent, {
          projectId: project.id,
          accountable: agent.principal.id,
          title: "Invalid",
        }),
      "forbidden",
    );
    expectCode(
      () =>
        board.updateTask(
          admin,
          first.id,
          { accountable: agent.principal.id },
          { expectedVersion: first.version },
        ),
      "forbidden",
    );
  });

  it("enforces agent assignment off/on and same-owner rules on creation and updates", () => {
    const { board, admin, owner, agent, peer, foreignAgent, project, task } =
      fixture();
    let item = task();
    expectCode(
      () =>
        board.updateTask(
          agent,
          item.id,
          { assignee: peer.principal.id },
          { expectedVersion: item.version },
        ),
      "forbidden",
    );
    expectCode(
      () =>
        board.createTask(agent, {
          title: "Delegated",
          projectId: project.id,
          accountable: owner.principal.id,
          assignee: peer.principal.id,
        }),
      "forbidden",
    );
    board.updateProject(admin, project.id, {
      settings: { allowAgentAssignment: true },
    });
    item = board.updateTask(
      agent,
      item.id,
      { assignee: peer.principal.id },
      { expectedVersion: item.version },
    );
    expect(item.assignee).toBe(peer.principal.id);
    expectCode(
      () =>
        board.updateTask(
          agent,
          item.id,
          { assignee: foreignAgent.principal.id },
          { expectedVersion: item.version },
        ),
      "forbidden",
    );
    expectCode(
      () =>
        board.updateTask(
          agent,
          item.id,
          { assignee: owner.principal.id },
          { expectedVersion: item.version },
        ),
      "forbidden",
    );
    expectCode(
      () =>
        board.updateTask(
          { ...agent, scopes: ["tasks:write"] },
          item.id,
          { assignee: peer.principal.id },
          { expectedVersion: item.version },
        ),
      "forbidden",
    );
    const self = board.claim(
      { ...agent, scopes: ["tasks:claim"] },
      task().id,
    ).task;
    expect(self.assignee).toBe(agent.principal.id);
    expect(
      board.updateTask(
        owner,
        item.id,
        { assignee: foreignAgent.principal.id },
        { expectedVersion: item.version },
      ).assignee,
    ).toBe(foreignAgent.principal.id);
  });

  it("detects direct, transitive, and self dependency cycles atomically", () => {
    const { board, admin, task } = fixture();
    const a = task("A");
    const b = task("B");
    const c = task("C");
    board.addDependency(admin, a.id, b.id, { expectedVersion: a.version });
    board.addDependency(admin, b.id, c.id, { expectedVersion: b.version });
    expectCode(
      () =>
        board.addDependency(admin, c.id, a.id, { expectedVersion: c.version }),
      "cycle",
    );
    expectCode(
      () =>
        board.addDependency(admin, c.id, c.id, { expectedVersion: c.version }),
      "cycle",
    );
    const currentB = board.getTask(admin, b.id);
    expectCode(
      () =>
        board.addDependency(admin, b.id, a.id, {
          expectedVersion: currentB.version,
        }),
      "cycle",
    );
    expect(board.listDependencies(admin, c.id, { limit: 100 }).items).toEqual(
      [],
    );
    expect(board.getTask(admin, c.id).version).toBe(c.version);
  });

  it("queries ready tasks using dependency completion and claims the highest priority candidate atomically", () => {
    const { board, admin, agent, project, task } = fixture();
    let predecessor = task("Predecessor");
    const dependent = task("Dependent");
    board.addDependency(admin, dependent.id, predecessor.id, {
      expectedVersion: dependent.version,
    });
    expect(
      board
        .listTasks(admin, { limit: 100, ready: true })
        .items.map((item) => item.id),
    ).toEqual([predecessor.id]);
    expectCode(() => board.claim(agent, dependent.id), "claim_conflict");
    predecessor = board.claim(agent, predecessor.id).task;
    expect(board.claimNext(agent, project.id)).toBeNull();
    predecessor = board.transition(
      agent,
      predecessor.id,
      { to: "in_review" },
      { leaseToken: predecessor.lease!.token },
    ).task;
    board.transition(
      agent,
      predecessor.id,
      { to: "done" },
      { leaseToken: predecessor.lease!.token },
    );
    let high = task("Priority");
    high = board.updateTask(
      admin,
      high.id,
      { priority: 5 },
      { expectedVersion: high.version },
    );
    expect(board.claimNext(agent, project.id)?.task.id).toBe(high.id);
    expect(board.claimNext(agent, project.id)?.task.id).toBe(dependent.id);
    expect(board.claimNext(agent, project.id)).toBeNull();
  });

  it("observes TTL expiry through the ready query and claim-next", () => {
    const { board, admin, agent, peer, project, advance, task } = fixture({
      leaseTtl: 1000,
    });
    const a = task("A");
    const b = task("B");
    board.claim(agent, a.id);
    board.claim(agent, b.id);
    advance(1000);
    expect(
      board.listTasks(admin, { limit: 100, ready: true }).items,
    ).toHaveLength(2);
    expect(board.claimNext(peer, project.id)?.task.lease?.holder).toBe(
      peer.principal.id,
    );
    const c = task("C");
    board.claim(agent, c.id);
    advance(1000);
    expect(board.claimNext(peer, project.id)).not.toBeNull();
    expect(
      board
        .listEvents(admin, { limit: 100 })
        .items.filter((event) => event.type === "lease_expired")
        .map((event) => event.taskId),
    ).toContain(c.id);
  });

  it("removes dependencies and exposes them through cursor pagination", () => {
    const { board, admin, task } = fixture();
    const a = task("A");
    const b = task("B");
    const c = task("C");
    const first = board.addDependency(admin, a.id, b.id, {
      expectedVersion: a.version,
    });
    const second = board.addDependency(admin, a.id, c.id, {
      expectedVersion: first.task.version,
    });
    const page = board.listDependencies(admin, a.id, { limit: 1 });
    expect(
      board.listDependencies(admin, a.id, {
        limit: 1,
        cursor: page.nextCursor!,
      }).items,
    ).toHaveLength(1);
    const updated = board.removeDependency(admin, a.id, first.dependency.id, {
      expectedVersion: second.task.version,
    });
    expect(
      board
        .listDependencies(admin, a.id, { limit: 100 })
        .items.map((dep) => dep.id),
    ).toEqual([second.dependency.id]);
    expectCode(
      () =>
        board.removeDependency(admin, b.id, second.dependency.id, {
          expectedVersion: b.version,
        }),
      "not_found",
    );
    expect(updated.version).toBe(second.task.version + 1);
  });

  it("supports subtasks and prevents parent cycles", () => {
    const { board, admin, project, owner, task } = fixture();
    const parent = task();
    const child = board.createTask(admin, {
      projectId: project.id,
      title: "Child",
      accountable: owner.principal.id,
      parentId: parent.id,
    });
    expect(
      board
        .listTasks(admin, { limit: 100, parentId: parent.id })
        .items.map((item) => item.id),
    ).toEqual([child.id]);
    expectCode(
      () =>
        board.updateTask(
          admin,
          parent.id,
          { parentId: child.id },
          { expectedVersion: parent.version },
        ),
      "cycle",
    );
    expectCode(
      () =>
        board.updateTask(
          admin,
          child.id,
          { parentId: child.id },
          { expectedVersion: child.version },
        ),
      "cycle",
    );
  });
});
