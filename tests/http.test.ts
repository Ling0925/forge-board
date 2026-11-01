import SwaggerParser from "@apidevtools/swagger-parser";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type Actor, taskSchema } from "../src/domain/index.js";
import { createApp } from "../src/http/index.js";
import { fixture } from "./helpers.js";

function httpFixture(settings: Parameters<typeof fixture>[0] = {}) {
  const f = fixture(settings);
  const app = createApp(f.board);
  const tokenFor = (actor: Actor) =>
    f.board.createToken(f.admin, {
      principalId: actor.principal.id,
      scopes: actor.scopes,
      projectIds: actor.projectIds,
    }).secret!;
  const secret = tokenFor(f.admin);
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
    token = secret,
  ) =>
    app.request(`/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { ...f, app, request, tokenFor };
}

async function success(response: Response) {
  const data = await response.json();
  expect(response.status, JSON.stringify(data)).toBe(200);
  return data;
}

describe("HTTP API", () => {
  it("maps authentication, scopes, project scopes, validation, and missing resources", async () => {
    const f = httpFixture();
    const missing = await f.app.request("/v1/tasks?limit=1");
    expect(missing.status).toBe(401);
    expect(missing.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(
      (await f.request("/tasks?limit=1", "GET", undefined, {}, "wrong")).status,
    ).toBe(401);
    const readOnly = f.tokenFor({ ...f.agent, scopes: ["tasks:read"] });
    expect(
      (
        await f.request(
          "/tasks",
          "POST",
          {
            projectId: f.project.id,
            title: "Denied",
            accountable: f.owner.principal.id,
          },
          {},
          readOnly,
        )
      ).status,
    ).toBe(403);
    const task = f.task();
    const scoped = f.tokenFor({ ...f.admin, projectIds: [] });
    expect(
      (await f.request(`/tasks/${task.id}`, "GET", undefined, {}, scoped))
        .status,
    ).toBe(403);
    expect(
      await success(
        await f.request("/projects?limit=10", "GET", undefined, {}, scoped),
      ),
    ).toEqual({ items: [], nextCursor: null });
    for (const path of [
      "/tasks",
      "/tasks?limit=no",
      "/tasks?limit=0",
      "/tasks?limit=1&ready=maybe",
    ]) {
      expect((await f.request(path)).status).toBe(422);
    }
    expect((await f.request("/tasks/missing")).status).toBe(404);
    expect((await f.request("/unknown")).status).toBe(404);
    expect(
      (
        await f.app.request("/v1/tasks", {
          method: "POST",
          headers: { Authorization: `Bearer ${readOnly}` },
          body: "{",
        })
      ).status,
    ).toBe(422);
    const disabledToken = f.tokenFor(f.peer);
    f.board.disablePrincipal(f.admin, f.peer.principal.id);
    expect(
      (await f.request("/tasks?limit=1", "GET", undefined, {}, disabledToken))
        .status,
    ).toBe(401);
  });

  it("uses If-Match and ETag and replays the original body and version after later writes", async () => {
    const f = httpFixture();
    const body = {
      projectId: f.project.id,
      accountable: f.owner.principal.id,
      title: "First",
      metadata: { nested: [true, null, { x: 1 }] },
    };
    const response = await f.request("/tasks", "POST", body, {
      "Idempotency-Key": "create",
    });
    const task = await success(response);
    expect(response.headers.get("ETag")).toBe(`"${task.version}"`);
    expect(
      await success(
        await f.request("/tasks", "POST", body, {
          "Idempotency-Key": "create",
        }),
      ),
    ).toEqual(task);
    const mismatch = await f.request(
      "/tasks",
      "POST",
      { ...body, title: "different" },
      { "Idempotency-Key": "create" },
    );
    expect(mismatch.status).toBe(422);
    expect((await mismatch.json()).error.code).toBe("idempotency_mismatch");
    const patch = { title: "Second" };
    const headers = {
      "If-Match": response.headers.get("ETag")!,
      "Idempotency-Key": "patch",
    };
    const updatedResponse = await f.request(
      `/tasks/${task.id}`,
      "PATCH",
      patch,
      headers,
    );
    const updated = await success(updatedResponse);
    expect(updatedResponse.headers.get("ETag")).toBe(`"${updated.version}"`);
    const stale = await f.request(
      `/tasks/${task.id}`,
      "PATCH",
      { title: "Stale" },
      { "If-Match": String(task.version) },
    );
    expect(stale.status).toBe(412);
    expect((await stale.json()).error.details.currentTask).toEqual(updated);
    expect((await f.request(`/tasks/${task.id}`, "PATCH", patch)).status).toBe(
      412,
    );
    expect(
      (
        await f.request(`/tasks/${task.id}`, "PATCH", patch, {
          "If-Match": 'W/"2"',
        })
      ).status,
    ).toBe(422);
    await success(
      await f.request(
        `/tasks/${task.id}`,
        "PATCH",
        { title: "Third" },
        { "If-Match": String(updated.version) },
      ),
    );
    const replay = await f.request(
      `/tasks/${task.id}`,
      "PATCH",
      patch,
      headers,
    );
    expect(await success(replay)).toEqual(updated);
    expect(replay.headers.get("ETag")).toBe(
      updatedResponse.headers.get("ETag"),
    );
  });

  it("exposes project settings, task queries, links, dependencies, labels, comments, and artifacts", async () => {
    const f = httpFixture();
    const project = await success(
      await f.request(
        "/projects",
        "POST",
        { key: "HTTP", name: "HTTP" },
        { "Idempotency-Key": "project" },
      ),
    );
    expect(await success(await f.request(`/projects/${project.id}`))).toEqual(
      project,
    );
    const settings = { leaseTtl: 1000, allowAgentAssignment: true };
    const updatedProject = await success(
      await f.request(
        `/projects/${project.id}`,
        "PATCH",
        { settings },
        { "Idempotency-Key": "settings" },
      ),
    );
    expect(updatedProject.settings).toEqual(settings);
    expect(
      (await success(await f.request("/projects?limit=1"))).nextCursor,
    ).not.toBeNull();
    let task = f.task("Parent");
    const dependency = f.task("Dependency");
    const write = async (path: string, body: object, method = "POST") => {
      const headers = {
        "If-Match": String(task.version),
        "Idempotency-Key": `${method}:${path}:${task.version}`,
      };
      const first = await f.request(
        `/tasks/${task.id}/${path}`,
        method,
        body,
        headers,
      );
      const data = await success(first);
      task = data.task ?? data;
      expect(first.headers.get("ETag")).toBe(`"${task.version}"`);
      expect(
        await success(
          await f.request(`/tasks/${task.id}/${path}`, method, body, headers),
        ),
      ).toEqual(data);
      return data;
    };
    const dep = await write("dependencies", { dependsOnId: dependency.id });
    expect(
      (
        await success(
          await f.request(`/tasks/${task.id}/dependencies?limit=10`),
        )
      ).items,
    ).toEqual([dep.dependency]);
    expect(
      (
        await success(
          await f.request(`/tasks?project=${f.project.id}&ready=true&limit=10`),
        )
      ).items.map((t: { id: string }) => t.id),
    ).toEqual([dependency.id]);
    const cycle = await f.request(
      `/tasks/${dependency.id}/dependencies`,
      "POST",
      { dependsOnId: task.id },
      { "If-Match": String(dependency.version) },
    );
    expect(cycle.status).toBe(409);
    expect((await cycle.json()).error.code).toBe("cycle");
    await write("dependencies", { dependencyId: dep.dependency.id }, "DELETE");
    const link = await write("links", {
      kind: "thread",
      ref: "gh:owner/repo#12",
    });
    expect(
      (
        await success(
          await f.request(
            `/tasks?link=${encodeURIComponent(link.link.ref)}&ready=true&limit=10`,
          ),
        )
      ).items,
    ).toEqual([task]);
    expect(
      (await success(await f.request(`/tasks/${task.id}/links?limit=10`)))
        .items,
    ).toEqual([link.link]);
    await write("links", { linkId: link.link.id }, "DELETE");
    const label = await success(
      await f.request(
        `/projects/${f.project.id}/labels`,
        "POST",
        { name: "API" },
        { "Idempotency-Key": "label" },
      ),
    );
    expect(
      (
        await success(
          await f.request(`/projects/${f.project.id}/labels?limit=10`),
        )
      ).items,
    ).toEqual([label]);
    await write("labels", { labelId: label.id });
    expect(task.labels).toEqual([label.id]);
    await write("labels", { labelId: label.id }, "DELETE");
    const question = await write("comments", {
      kind: "question",
      body: "Which API?",
    });
    expect(task.status).toBe("input_required");
    await write("comments", {
      kind: "answer",
      body: "This API",
      replyTo: question.comment.id,
    });
    expect(task.status).toBe("in_progress");
    expect(
      (await success(await f.request(`/tasks/${task.id}/comments?limit=10`)))
        .items,
    ).toHaveLength(2);
    const artifact = await write("artifacts", {
      name: "output",
      mediaType: "text/plain",
      content: { uri: null, text: "Result" },
    });
    expect(
      (await success(await f.request(`/tasks/${task.id}/artifacts?limit=10`)))
        .items,
    ).toEqual([artifact.artifact]);
  });

  it("claims, renews, releases, reclaims, transitions, and supports a human approval inbox", async () => {
    const f = httpFixture({ approvalRequired: ["in_review->done"] });
    const task = f.task();
    const agentToken = f.tokenFor(f.agent);
    const claim = await success(
      await f.request(
        "/tasks/claim-next",
        "POST",
        { projectId: f.project.id },
        { "Idempotency-Key": "claim" },
        agentToken,
      ),
    );
    expect(claim.task.id).toBe(task.id);
    const restricted = f.tokenFor({ ...f.agent, projectIds: [] });
    expect(
      (
        await f.request(
          "/tasks/claim-next",
          "POST",
          { projectId: f.project.id },
          { "Idempotency-Key": "claim" },
          restricted,
        )
      ).status,
    ).toBe(403);

    const conflict = await f.request(`/tasks/${task.id}/claim`, "POST");
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.details.holder).toBe(
      f.agent.principal.id,
    );
    const leaseToken = claim.task.lease.token;
    const renew = await success(
      await f.request(
        `/tasks/${task.id}/lease/renew`,
        "POST",
        { leaseToken },
        { "Idempotency-Key": "renew" },
        agentToken,
      ),
    );
    expect(renew.version).toBe(claim.task.version + 1);
    const progress = await success(
      await f.request(
        `/tasks/${task.id}`,
        "PATCH",
        { progress: "Working", leaseToken },
        {},
        agentToken,
      ),
    );
    expect(progress.progress).toBe("Working");
    const release = await success(
      await f.request(
        `/tasks/${task.id}/release`,
        "POST",
        { leaseToken },
        { "Idempotency-Key": "release" },
        agentToken,
      ),
    );
    expect(release.task.status).toBe("todo");
    const next = await success(
      await f.request(`/tasks/${task.id}/claim`, "POST", {}, {}, agentToken),
    );
    const reclaim = await success(
      await f.request(
        `/tasks/${task.id}/reclaim`,
        "POST",
        {},
        { "If-Match": String(next.task.version), "Idempotency-Key": "reclaim" },
      ),
    );
    expect(reclaim.task.lease).toBeNull();
    const lost = await f.request(
      `/tasks/${task.id}/lease/renew`,
      "POST",
      { leaseToken },
      {},
      agentToken,
    );
    expect(lost.status).toBe(409);
    expect((await lost.json()).error.code).toBe("lease_lost");
    const working = f.board.claim(f.agent, task.id).task;
    const reviewed = await success(
      await f.request(
        `/tasks/${task.id}/transition`,
        "POST",
        { to: "in_review", leaseToken: working.lease!.token },
        {},
        agentToken,
      ),
    );
    const pending = await success(
      await f.request(
        `/tasks/${task.id}/transition`,
        "POST",
        { to: "done", message: "Ready", leaseToken: reviewed.task.lease.token },
        { "Idempotency-Key": "transition" },
        agentToken,
      ),
    );
    expect(
      (
        await success(
          await f.request(
            `/approvals?project=${f.project.id}&state=pending&limit=10`,
          ),
        )
      ).items,
    ).toEqual([pending.approval]);
    expect(
      (await success(await f.request(`/tasks/${task.id}/approvals?limit=10`)))
        .items,
    ).toEqual([pending.approval]);
    const headers = {
      "If-Match": String(pending.task.version),
      "Idempotency-Key": "decide",
    };
    expect(
      (
        await f.request(
          `/approvals/${pending.approval.id}/decide`,
          "POST",
          { decision: "approved", leaseToken: working.lease!.token },
          headers,
          agentToken,
        )
      ).status,
    ).toBe(403);
    const done = await success(
      await f.request(
        `/approvals/${pending.approval.id}/decide`,
        "POST",
        { decision: "approved" },
        headers,
      ),
    );
    expect(done.task.status).toBe("done");
    expect(
      await success(
        await f.request(
          `/approvals/${pending.approval.id}/decide`,
          "POST",
          { decision: "approved" },
          headers,
        ),
      ),
    ).toEqual(done);
    expect(
      await success(
        await f.request("/tasks/claim-next", "POST", {
          projectId: f.project.id,
        }),
      ),
    ).toBeNull();
  });

  it("administers principals and tokens with idempotency on every mutation", async () => {
    const f = httpFixture();
    const principalBody = { kind: "human", name: "API user" };
    const person = await success(
      await f.request("/principals", "POST", principalBody, {
        "Idempotency-Key": "person",
      }),
    );
    expect(
      await success(
        await f.request("/principals", "POST", principalBody, {
          "Idempotency-Key": "person",
        }),
      ),
    ).toEqual(person);
    expect(
      (await success(await f.request("/principals?limit=100"))).items,
    ).toContainEqual(person);
    const body = {
      principalId: person.id,
      scopes: ["tasks:read"],
      projectIds: [f.project.id],
    };
    const token = await success(
      await f.request("/tokens", "POST", body, { "Idempotency-Key": "token" }),
    );
    expect(
      await success(
        await f.request("/tokens", "POST", body, {
          "Idempotency-Key": "token",
        }),
      ),
    ).toEqual({ ...token, secret: null });
    expect(
      JSON.stringify(await success(await f.request("/tokens?limit=100"))),
    ).not.toContain(token.secret);
    const revoked = await success(
      await f.request(
        `/tokens/${token.token.id}/revoke`,
        "POST",
        {},
        { "Idempotency-Key": "revoke" },
      ),
    );
    expect(
      await success(
        await f.request(
          `/tokens/${token.token.id}/revoke`,
          "POST",
          {},
          { "Idempotency-Key": "revoke" },
        ),
      ),
    ).toEqual(revoked);
    expect(
      (await f.request("/tasks?limit=1", "GET", undefined, {}, token.secret))
        .status,
    ).toBe(401);
    const disabled = await success(
      await f.request(
        `/principals/${person.id}/disable`,
        "POST",
        {},
        { "Idempotency-Key": "disable" },
      ),
    );
    expect(
      await success(
        await f.request(
          `/principals/${person.id}/disable`,
          "POST",
          {},
          { "Idempotency-Key": "disable" },
        ),
      ),
    ).toEqual(disabled);
  });

  it("serves OpenAPI 3.1 with every route, generated schemas, and resolvable references", async () => {
    const { app } = httpFixture();
    const response = await app.request("/v1/openapi.json");
    const doc = await success(response);
    expect(doc.openapi).toBe("3.1.0");
    const documented = Object.entries(doc.paths)
      .flatMap(([path, methods]) =>
        Object.keys(methods as object).map(
          (method) => `${method.toUpperCase()} ${path}`,
        ),
      )
      .sort();
    const routes = app.routes
      .filter((route) => route.method !== "ALL")
      .map(
        (route) => `${route.method} ${route.path.replace(/:([^/]+)/g, "{$1}")}`,
      )
      .sort();
    expect(documented).toEqual(routes);
    function resolve(ref: string): unknown {
      expect(ref.startsWith("#/components/schemas/")).toBe(true);
      return ref
        .slice(2)
        .split("/")
        .reduce((value, key) => value[key], doc);
    }
    function visit(value: unknown) {
      if (value === null || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (key === "$ref") expect(resolve(String(child))).toBeDefined();
        else visit(child);
      }
    }
    visit(doc);
    await SwaggerParser.validate(structuredClone(doc));
    const taskResponse =
      doc.paths["/v1/tasks/{id}"].get.responses["200"].content[
        "application/json"
      ].schema;
    const generated = z.toJSONSchema(taskSchema, { io: "input" });
    expect(resolve(taskResponse.$ref)).toMatchObject({
      type: generated.type,
      required: generated.required,
    });
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(
        methods as Record<string, { parameters: Array<{ name: string }> }>,
      )) {
        if (method !== "get")
          expect(
            operation.parameters.map((p) => p.name),
            path,
          ).toContain("Idempotency-Key");
      }
    }
  });
});
