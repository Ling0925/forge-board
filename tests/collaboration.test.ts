import { describe, expect, it } from "vitest";
import { expectCode, fixture } from "./helpers.js";

describe("comments, artifacts, links, and labels", () => {
  it("returns duplicate links unchanged and removes by kind/ref idempotently", () => {
    const { board, admin, agent, repo, task, advance } = fixture({
      leaseTtl: 1000,
    });
    const item = board.claim(agent, task().id).task;
    const input = { kind: "thread" as const, ref: "shared", title: "Original" };
    const linked = board.addLink(agent, item.id, input, {
      expectedVersion: item.version,
      leaseToken: item.lease!.token,
    });
    const events = repo.events(0);
    advance(1);
    const mutation = {
      expectedVersion: linked.task.version,
      leaseToken: item.lease!.token,
    };
    expect(
      board.addLink(agent, item.id, { ...input, title: "Ignored" }, mutation),
    ).toEqual(linked);
    expect(board.getTask(admin, item.id)).toEqual(linked.task);
    expect(repo.events(0)).toEqual(events);
    expectCode(
      () =>
        board.addLink(agent, item.id, input, {
          ...mutation,
          expectedVersion: item.version,
        }),
      "version_mismatch",
    );
    expectCode(
      () =>
        board.addLink(agent, item.id, input, {
          expectedVersion: linked.task.version,
        }),
      "lease_lost",
    );
    const otherKind = board.addLink(
      agent,
      item.id,
      { kind: "session", ref: input.ref },
      mutation,
    );
    const otherTask = task("Other");
    const otherLink = board.addLink(admin, otherTask.id, input, {
      expectedVersion: otherTask.version,
    });
    const removed = board.removeLink(
      agent,
      item.id,
      { kind: input.kind, ref: input.ref },
      { ...mutation, expectedVersion: otherKind.task.version },
    );
    expect(removed.version).toBe(otherKind.task.version + 1);
    expect(board.listLinks(admin, item.id, {}).items).toEqual([otherKind.link]);
    expect(board.listLinks(admin, otherTask.id, {}).items).toEqual([
      otherLink.link,
    ]);
    const afterRemoval = repo.events(0);
    const currentMutation = { ...mutation, expectedVersion: removed.version };
    expect(
      board.removeLink(
        agent,
        item.id,
        { kind: input.kind, ref: input.ref },
        currentMutation,
      ),
    ).toEqual(removed);
    expect(repo.events(0)).toEqual(afterRemoval);
    expectCode(
      () =>
        board.removeLink(
          agent,
          item.id,
          { linkId: linked.link.id },
          currentMutation,
        ),
      "not_found",
    );
    expectCode(
      () =>
        board.removeLink(
          agent,
          item.id,
          { linkId: otherLink.link.id },
          currentMutation,
        ),
      "not_found",
    );
    expectCode(
      () =>
        board.removeLink(
          agent,
          item.id,
          { kind: input.kind, ref: input.ref },
          { ...currentMutation, expectedVersion: item.version },
        ),
      "version_mismatch",
    );
    expectCode(
      () =>
        board.removeLink(
          agent,
          item.id,
          { kind: input.kind, ref: input.ref },
          { expectedVersion: removed.version },
        ),
      "lease_lost",
    );
    expectCode(
      () =>
        board.removeLink(
          { ...agent, scopes: ["tasks:read"] },
          item.id,
          { kind: input.kind, ref: input.ref },
          currentMutation,
        ),
      "forbidden",
    );
    expectCode(
      () =>
        board.addLink(
          { ...agent, projectIds: [] },
          item.id,
          { kind: "session", ref: input.ref },
          currentMutation,
        ),
      "forbidden",
    );
  });

  it("allows questions on todo, blocked, and in-review tasks", () => {
    const { board, admin, task } = fixture();
    for (const status of ["todo", "blocked", "in_review"] as const) {
      let item = task(status);
      if (status !== "todo") {
        item = board.transition(
          admin,
          item.id,
          { to: "in_progress" },
          { expectedVersion: item.version },
        ).task;
        item = board.transition(
          admin,
          item.id,
          { to: status },
          { expectedVersion: item.version },
        ).task;
      }
      expect(
        board.addComment(
          admin,
          item.id,
          { kind: "question", body: "Need input" },
          { expectedVersion: item.version },
        ).task.status,
      ).toBe("input_required");
    }
  });
  it("moves questions to input_required and answer replies back to in_progress", () => {
    const { board, owner, agent, task } = fixture();
    let item = board.claim(agent, task().id).task;
    const question = board.addComment(
      agent,
      item.id,
      { kind: "question", body: "Which format?" },
      { expectedVersion: item.version, leaseToken: item.lease!.token },
    );
    expect(question.task.status).toBe("input_required");
    item = board.addComment(
      owner,
      item.id,
      { kind: "answer", replyTo: question.comment.id, body: "JSON" },
      { expectedVersion: question.task.version },
    ).task;
    expect(item.status).toBe("in_progress");
    const decision = board.addComment(
      owner,
      item.id,
      { kind: "decision", body: "Use JSON" },
      { expectedVersion: item.version },
    );
    expect(decision.task.status).toBe("in_progress");
    expect(
      board
        .listComments(owner, item.id, { limit: 100 })
        .items.map((comment) => comment.kind)
        .sort(),
    ).toEqual(["answer", "decision", "question"]);
    expectCode(
      () =>
        board.addComment(
          owner,
          item.id,
          { kind: "answer", body: "No question" },
          { expectedVersion: decision.task.version },
        ),
      "conflict",
    );
  });

  it("enforces comment reply task boundaries and gates automatic question/answer transitions", () => {
    const { board, admin, agent, owner, task } = fixture({
      approvalRequired: [
        "in_progress->input_required",
        "input_required->in_progress",
      ],
    });
    const item = board.claim(agent, task().id).task;
    const question = board.addComment(
      agent,
      item.id,
      { kind: "question", body: "Review?" },
      { expectedVersion: item.version, leaseToken: item.lease!.token },
    );
    expect(question.task.status).toBe("in_progress");
    const approved = board.decideApproval(
      owner,
      question.approval!.id,
      "approved",
      { expectedVersion: question.task.version },
    );
    expect(approved.task.status).toBe("input_required");
    const answer = board.addComment(
      owner,
      item.id,
      { kind: "answer", body: "Yes", replyTo: question.comment.id },
      { expectedVersion: approved.task.version },
    );
    expect(answer.task.status).toBe("input_required");
    expect(
      board.decideApproval(admin, answer.approval!.id, "approved", {
        expectedVersion: answer.task.version,
      }).task.status,
    ).toBe("in_progress");
    const unrelated = task("Unrelated");
    expectCode(
      () =>
        board.addComment(
          owner,
          unrelated.id,
          { kind: "answer", body: "Cross task", replyTo: question.comment.id },
          { expectedVersion: unrelated.version },
        ),
      "conflict",
    );
  });

  it("increments artifact versions per task and name and supports URI or inline text", () => {
    const { board, admin, task } = fixture();
    let item = task();
    const first = board.addArtifact(
      admin,
      item.id,
      {
        name: "report",
        mediaType: "text/plain",
        content: { uri: null, text: "First" },
      },
      { expectedVersion: item.version },
    );
    const second = board.addArtifact(
      admin,
      item.id,
      {
        name: "report",
        mediaType: "text/plain",
        content: { uri: "file:///report", text: null },
      },
      { expectedVersion: first.task.version },
    );
    const other = board.addArtifact(
      admin,
      item.id,
      {
        name: "log",
        mediaType: "text/plain",
        content: { uri: null, text: "Log" },
      },
      { expectedVersion: second.task.version },
    );
    expect([
      first.artifact.version,
      second.artifact.version,
      other.artifact.version,
    ]).toEqual([1, 2, 1]);
    item = task("Other task");
    expect(
      board.addArtifact(
        admin,
        item.id,
        {
          name: "report",
          mediaType: "text/plain",
          content: { uri: null, text: "Other" },
        },
        { expectedVersion: item.version },
      ).artifact.version,
    ).toBe(1);
    expect(
      board.listArtifacts(admin, first.task.id, { limit: 100 }).items,
    ).toHaveLength(3);
  });

  it("supports each link kind, reference queries, and deletion", () => {
    const { board, admin, task } = fixture();
    let item = task();
    for (const kind of [
      "thread",
      "session",
      "pr",
      "issue",
      "url",
      "task",
    ] as const)
      item = board.addLink(
        admin,
        item.id,
        { kind, ref: `${kind}:reference` },
        { expectedVersion: item.version },
      ).task;
    expect(
      board
        .listTasks(admin, { limit: 100, link: "thread:reference" })
        .items.map((task) => task.id),
    ).toEqual([item.id]);
    const links = board.listLinks(admin, item.id, { limit: 100 }).items;
    expect(links).toHaveLength(6);
    const link = links.find((link) => link.kind === "thread")!;
    item = board.removeLink(
      admin,
      item.id,
      { linkId: link.id },
      {
        expectedVersion: item.version,
      },
    );
    expect(
      board.listTasks(admin, { limit: 100, link: "thread:reference" }).items,
    ).toEqual([]);
    expectCode(
      () =>
        board.removeLink(
          admin,
          item.id,
          { linkId: link.id },
          {
            expectedVersion: item.version,
          },
        ),
      "not_found",
    );
  });

  it("keeps labels within their project and supports assignment, filtering, and removal", () => {
    const { board, admin, project, task } = fixture();
    let item = task();
    const label = board.createLabel(admin, project.id, "bug");
    expect(board.listLabels(admin, project.id, { limit: 100 }).items).toEqual([
      label,
    ]);
    item = board.addLabel(admin, item.id, label.id, {
      expectedVersion: item.version,
    });
    expect(
      board
        .listTasks(admin, { limit: 100, label: label.id })
        .items.map((task) => task.id),
    ).toEqual([item.id]);
    expect(board.getTask(admin, item.id).labels).toEqual([label.id]);
    const otherProject = board.createProject(admin, {
      key: "OTHER",
      name: "Other",
    });
    const otherLabel = board.createLabel(admin, otherProject.id, "other");
    expectCode(
      () =>
        board.addLabel(admin, item.id, otherLabel.id, {
          expectedVersion: item.version,
        }),
      "conflict",
    );
    item = board.removeLabel(admin, item.id, label.id, {
      expectedVersion: item.version,
    });
    expect(item.labels).toEqual([]);
    expect(
      board.listTasks(admin, { limit: 100, label: label.id }).items,
    ).toEqual([]);
  });
});
