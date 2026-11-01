import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { fixture } from "./helpers.js";
import {
  call,
  connectMcp,
  serveBoard,
  subscribe,
  toolData,
} from "./transport-helpers.js";

describe("REST and MCP agent acceptance", () => {
  it("races, collaborates, hands off and finishes with human approval while SSE observes every event in order", async () => {
    const f = fixture({ approvalRequired: ["in_review->done"] }, {});
    const token = (actor: typeof f.agent) =>
      f.board.createToken(f.admin, {
        principalId: actor.principal.id,
        scopes: actor.scopes,
        projectIds: [f.project.id],
      }).secret!;
    const aToken = token(f.agent);
    const bToken = token(f.peer);
    const humanToken = f.board.createToken(f.admin, {
      principalId: f.owner.principal.id,
      scopes: ["tasks:read", "tasks:approve"],
    }).secret!;
    const server = await serveBoard(f.board);
    const b = await connectMcp(server.url, bToken);
    const request = (
      path: string,
      method = "GET",
      body?: unknown,
      headers: Record<string, string> = {},
      secret = aToken,
    ) =>
      fetch(`${server.url}/v1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const rest = async (
      path: string,
      method = "GET",
      body?: unknown,
      headers: Record<string, string> = {},
      secret = aToken,
    ) => {
      const response = await request(path, method, body, headers, secret);
      const data = await response.json();
      expect(response.status, JSON.stringify(data)).toBe(200);
      return data;
    };
    const after = f.repo.events(0).at(-1)!.seq;
    const stream = await subscribe(
      `${server.url}/v1/events?after=${after}`,
      humanToken,
    );
    try {
      const input = {
        projectId: f.project.id,
        title: "Forge work item",
        description: "Implement shared task coordination",
        accountable: f.owner.principal.id,
        authorization: "explicit",
        metadata: {
          forge: { profileId: "worker", routerSessionId: "router-1" },
        },
        links: [{ kind: "thread", ref: "forge:thread:thread-1" }],
      };
      const created = await rest("/tasks", "POST", input, {
        "Idempotency-Key": "work-item-1",
      });
      expect(
        await rest("/tasks", "POST", input, {
          "Idempotency-Key": "work-item-1",
        }),
      ).toEqual(created);
      const firstEvent = await stream.next();
      expect(firstEvent).toEqual(f.repo.events(after)[0]);
      expect(
        (
          await rest(
            "/tasks?limit=10&status=todo&link=forge%3Athread%3Athread-1",
          )
        ).items,
      ).toEqual([created]);
      expect(
        (
          await call(b, "board_list", {
            ready: true,
            projectId: f.project.id,
            limit: 10,
          })
        ).items,
      ).toEqual([created]);

      const [aRace, bRace] = await Promise.all([
        request(
          `/tasks/${created.id}/claim`,
          "POST",
          {},
          { "Idempotency-Key": "race-a" },
        ),
        b.callTool({
          name: "board_claim",
          arguments: { id: created.id, idempotencyKey: "race-b" },
        }),
      ]);
      const aResult = await aRace.json();
      const bResult = toolData(bRace as CallToolResult);
      expect(Number(aRace.ok) + Number(bRace.isError !== true)).toBe(1);
      const loser = aRace.ok ? bResult : aResult;
      const winner = aRace.ok ? aResult : bResult;
      expect(loser.error).toMatchObject({
        code: "claim_conflict",
        details: { currentTask: winner.task },
      });
      expect(
        f.repo.events(after).filter((event) => event.type === "task_claimed"),
      ).toHaveLength(1);
      let task = winner.task;
      if (!aRace.ok) {
        expect(aRace.status).toBe(409);
        await call(b, "board_release", {
          id: task.id,
          leaseToken: task.lease.token,
        });
        task = (await rest(`/tasks/${task.id}/claim`, "POST", {})).task;
      }
      expect(task.lease.holder).toBe(f.agent.principal.id);
      const aLease = task.lease.token;
      task = await rest(`/tasks/${task.id}`, "PATCH", {
        progress: "Implementation started",
        leaseToken: aLease,
      });
      task = await rest(
        `/tasks/${task.id}`,
        "PATCH",
        {
          metadata: {
            ...input.metadata,
            forge: {
              ...input.metadata.forge,
              worktree: "/tmp/forge-work-item",
            },
          },
          leaseToken: aLease,
        },
        { "If-Match": `"${task.version}"` },
      );
      task = (
        await rest(
          `/tasks/${task.id}/links`,
          "POST",
          {
            kind: "session",
            ref: "forge:session:worker-1",
            leaseToken: aLease,
          },
          { "If-Match": String(task.version) },
        )
      ).task;
      task = (
        await rest(`/tasks/${task.id}/transition`, "POST", {
          to: "blocked",
          message: "Awaiting input",
          leaseToken: aLease,
        })
      ).task;
      expect(
        (
          await rest(
            "/tasks?limit=10&status=blocked&link=forge%3Asession%3Aworker-1",
          )
        ).items,
      ).toEqual([task]);
      task = (
        await rest(`/tasks/${task.id}/transition`, "POST", {
          to: "in_progress",
          leaseToken: aLease,
        })
      ).task;

      const question = await rest(
        `/tasks/${task.id}/comments`,
        "POST",
        {
          kind: "question",
          body: "Which output format?",
          leaseToken: aLease,
        },
        { "If-Match": String(task.version), "Idempotency-Key": "question" },
      );
      expect(question.task.status).toBe("input_required");
      const read = await call(b, "board_get", {
        id: task.id,
        comments: { limit: 10 },
        links: { limit: 10 },
      });
      expect(read.comments.items).toEqual([question.comment]);
      expect(
        read.links.items.map((link: { kind: string }) => link.kind).sort(),
      ).toEqual(["session", "thread"]);
      const answer = await call(b, "board_comment", {
        id: task.id,
        kind: "answer",
        body: "Use JSON.",
        replyTo: question.comment.id,
        expectedVersion: question.task.version,
        idempotencyKey: "answer",
      });
      expect(answer.task.status).toBe("in_progress");
      const draft = await rest(
        `/tasks/${task.id}/artifacts`,
        "POST",
        {
          name: "result",
          mediaType: "application/json",
          content: { uri: null, text: '{"draft":true}' },
          leaseToken: aLease,
        },
        { "If-Match": String(answer.task.version) },
      );
      const artifact = await call(b, "board_artifact", {
        id: task.id,
        name: "result",
        mediaType: "application/json",
        content: { uri: "file:///tmp/result.json", text: null },
        expectedVersion: draft.task.version,
        idempotencyKey: "artifact",
      });
      expect(artifact.artifact.version).toBe(2);
      task = (
        await rest(
          `/tasks/${task.id}/release`,
          "POST",
          { leaseToken: aLease },
          { "Idempotency-Key": "handoff" },
        )
      ).task;
      expect(task).toMatchObject({ status: "todo", lease: null });
      task = (
        await call(b, "board_claim", {
          id: task.id,
          idempotencyKey: "handoff-claim",
        })
      ).task;
      const bLease = task.lease.token;
      expect(task.lease.holder).toBe(f.peer.principal.id);
      expect(
        (
          await request(`/tasks/${task.id}`, "PATCH", {
            progress: "Stale",
            leaseToken: aLease,
          })
        ).status,
      ).toBe(409);
      task = await call(b, "board_update", {
        id: task.id,
        progress: "Ready for human review",
        leaseToken: bLease,
      });
      task = (
        await call(b, "board_transition", {
          id: task.id,
          to: "in_review",
          leaseToken: bLease,
        })
      ).task;
      const gated = await call(b, "board_transition", {
        id: task.id,
        to: "done",
        leaseToken: bLease,
        idempotencyKey: "finish",
      });
      expect(gated.task.status).toBe("in_review");
      expect(gated.approval).toMatchObject({
        state: "pending",
        requestedBy: f.peer.principal.id,
      });
      const approved = await rest(
        `/approvals/${gated.approval.id}/decide`,
        "POST",
        { decision: "approved" },
        {
          "If-Match": String(gated.task.version),
          "Idempotency-Key": "human-approve",
        },
        humanToken,
      );
      expect(approved.task).toMatchObject({ status: "done", lease: null });
      expect(approved.approval).toMatchObject({
        state: "approved",
        decidedBy: f.owner.principal.id,
      });
      const detail = await call(b, "board_get", {
        id: task.id,
        comments: { limit: 10 },
        artifacts: { limit: 10 },
        approvals: { limit: 10 },
      });
      expect(detail.task).toEqual(approved.task);
      expect(
        detail.comments.items
          .map((comment: { kind: string }) => comment.kind)
          .sort(),
      ).toEqual(["answer", "question"]);
      expect(detail.artifacts.items).toHaveLength(2);
      expect(detail.approvals.items).toEqual([approved.approval]);
      const expected = f.repo.events(after);
      const observed = [firstEvent];
      for (const _ of expected.slice(1)) observed.push(await stream.next());
      expect(observed).toEqual(expected);
      expect(observed.map((event) => event.seq)).toEqual(
        [...new Set(observed.map((event) => event.seq))].sort((a, b) => a - b),
      );
      expect(observed.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          "task_created",
          "link_added",
          "task_claimed",
          "task_updated",
          "comment_added",
          "artifact_added",
          "approval_requested",
          "approval_approved",
        ]),
      );
      for (const event of observed.filter((event) =>
        [f.agent.principal.id, f.peer.principal.id].includes(event.actor),
      ))
        expect(event.owner).toBe(f.owner.principal.id);
      expect(
        observed.find((event) => event.type === "task_created"),
      ).toMatchObject({
        taskId: created.id,
        actor: f.agent.principal.id,
        owner: f.owner.principal.id,
      });
      expect(
        observed.find((event) => event.type === "approval_approved"),
      ).toMatchObject({
        type: "approval_approved",
        actor: f.owner.principal.id,
        owner: null,
      });
    } finally {
      stream.close();
      await b.close();
      await server.close();
    }
  });
});
