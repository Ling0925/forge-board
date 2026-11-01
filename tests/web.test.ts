import { describe, expect, it } from "vitest";
import { createApp } from "../src/http/index.js";
import { fixture } from "./helpers.js";

function webFixture(settings?: Parameters<typeof fixture>[1]) {
  const f = fixture({ approvalRequired: ["in_review->done"] }, settings);
  const app = createApp(f.board);
  const token = f.board.createToken(f.admin, {
    principalId: f.owner.principal.id,
    scopes: ["tasks:read"],
  });
  const headers = { Authorization: `Bearer ${token.secret}` };
  return { ...f, app, token, headers };
}

function nextPage(html: string, cursor: string) {
  const links = [...html.matchAll(/href="([^"]+)"/g)].map((match) =>
    match[1]!.replaceAll("&amp;", "&"),
  );
  return links.find((link) => link.includes(`${cursor}=`))!;
}

describe("read-only web pages", () => {
  it("shows project names, task titles, and related lists without query parameters after login", async () => {
    const f = webFixture();
    const first = f.task("First smoke task");
    const second = f.task("Second smoke task");
    const comment = f.board.addComment(
      f.admin,
      first.id,
      {
        kind: "comment",
        body: "Smoke comment",
      },
      { expectedVersion: first.version },
    ).comment;
    const logged = await f.app.request("/ui/login", {
      method: "POST",
      body: new URLSearchParams({ token: f.token.secret! }),
    });
    expect(logged.status).toBe(303);
    const headers = {
      Cookie: logged.headers.get("Set-Cookie")!.split(";")[0]!,
    };
    for (const path of ["/", `/?project=${f.project.id}`, "/?limit="]) {
      const response = await f.app.request(path, { headers });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(f.project.name);
      expect(html).toContain(first.title);
      expect(html).toContain(second.title);
      expect(html).not.toContain("limit=undefined");
      expect(html).toContain('name="limit" min="1" value=""');
    }
    const response = await f.app.request(`/tasks/${first.id}`, { headers });
    expect(response.status).toBe(200);
    const detail = await response.text();
    expect(detail).toContain(comment.body);
    for (const section of ["依赖", "关联", "产物", "评论", "审批", "活动"])
      expect(detail).toContain(`<h2>${section}</h2>`);
    expect(detail).not.toContain("limit=undefined");
  });

  it("uses POST login with an HttpOnly session cookie, never query tokens, and keeps API writes Bearer-only", async () => {
    const f = webFixture();
    const login = await f.app.request("/ui/login");
    const html = await login.text();
    expect(html).toContain('method="post" action="/ui/login"');
    expect(html).toContain('type="password"');
    expect(login.headers.get("Cache-Control")).toBe("no-store");
    expect(login.headers.get("Referrer-Policy")).toBe("no-referrer");
    const query = await f.app.request(`/?token=${f.token.secret}`);
    expect(query.status).toBe(302);
    expect(query.headers.get("Location")).toBe("/ui/login");
    expect(query.headers.has("Set-Cookie")).toBe(false);
    const post = (
      token: string,
      url = "/ui/login",
      headers: Record<string, string> = {},
    ) =>
      f.app.request(url, {
        method: "POST",
        body: new URLSearchParams({ token }),
        headers,
      });
    const bad = await post("wrong");
    expect(bad.status).toBe(401);
    expect(bad.headers.has("Set-Cookie")).toBe(false);
    const noRead = f.board.createToken(f.admin, {
      principalId: f.owner.principal.id,
      scopes: ["tasks:write"],
    }).secret!;
    expect((await post(noRead)).status).toBe(403);
    const logged = await post(f.token.secret!);
    expect(logged.status).toBe(303);
    expect(logged.headers.get("Location")).toBe("/");
    const setCookie = logged.headers.get("Set-Cookie")!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toMatch(/Max-Age|Expires/);
    expect(
      (
        await post(f.token.secret!, "https://board.example/ui/login")
      ).headers.get("Set-Cookie"),
    ).toContain("Secure");
    expect(
      (
        await post(f.token.secret!, "/ui/login", {
          "X-Forwarded-Proto": "https",
        })
      ).headers.get("Set-Cookie"),
    ).toContain("Secure");
    const headers = { Cookie: setCookie.split(";")[0]! };
    const page = await f.app.request("/?limit=10", { headers });
    expect(page.status).toBe(200);
    expect(await page.text()).not.toContain(f.token.secret!);
    for (const path of ["/v1/tasks", "/mcp"])
      expect(
        (await f.app.request(path, { method: "POST", headers, body: "{}" }))
          .status,
      ).toBe(401);
    const task = f.task();
    expect(
      (await f.app.request(`/tasks/${task.id}`, { method: "POST", headers }))
        .status,
    ).toBe(404);
    f.board.revokeToken(f.admin, f.token.token.id);
    expect((await f.app.request("/?limit=10", { headers })).status).toBe(401);
  });

  it("escapes fields and every related collection and renders cursor pages without truncating them", async () => {
    const f = webFixture({ maxPageSize: 1 });
    const attack = '<script>alert("x")</script>&\'';
    const escaped =
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;";
    f.board.updateProject(f.admin, f.project.id, { name: attack });
    const dependency = f.task("Dependency");
    f.advance(1);
    let task = f.board.createTask(f.admin, {
      projectId: f.project.id,
      accountable: f.owner.principal.id,
      title: attack,
      description: attack,
      metadata: { [attack]: attack },
    });
    task = f.board.addDependency(f.admin, task.id, dependency.id, {
      expectedVersion: task.version,
    }).task;
    for (const ref of [attack, "Second link"]) {
      f.advance(1);
      task = f.board.addLink(
        f.admin,
        task.id,
        { kind: "url", ref, title: attack },
        { expectedVersion: task.version },
      ).task;
    }
    for (const body of [attack, "Second comment"]) {
      f.advance(1);
      task = f.board.addComment(
        f.admin,
        task.id,
        { kind: "comment", body },
        { expectedVersion: task.version },
      ).task;
    }
    f.advance(1);
    task = f.board.addArtifact(
      f.admin,
      task.id,
      { name: attack, mediaType: attack, content: { uri: null, text: attack } },
      { expectedVersion: task.version },
    ).task;
    f.advance(1);
    task = f.board.addArtifact(
      f.admin,
      task.id,
      {
        name: "URI",
        mediaType: "text/plain",
        content: { uri: "javascript:alert(1)", text: null },
      },
      { expectedVersion: task.version },
    ).task;
    for (const to of ["in_progress", "in_review", "done"] as const)
      task = f.board.transition(
        f.admin,
        task.id,
        { to, message: attack },
        { expectedVersion: task.version },
      ).task;
    const get = (path: string) => f.app.request(path, { headers: f.headers });
    const root = await (await get("/")).text();
    expect(root).toContain(escaped);
    expect(root).not.toContain(attack);
    const board = await (await get(`/?project=${f.project.id}`)).text();
    expect(board).toContain("in_review");
    expect(board).toContain("Dependency");
    const boardNext = await (await get(nextPage(board, "tasksCursor"))).text();
    expect(boardNext).toContain(escaped);
    expect(boardNext).not.toContain("Dependency");
    const path = `/tasks/${task.id}?limit=10`;
    const detail = await (await get(path)).text();
    for (const section of [
      "字段",
      "依赖",
      "关联",
      "产物",
      "评论",
      "审批",
      "活动",
    ])
      expect(detail).toContain(`<h2>${section}</h2>`);
    expect(detail).toContain(escaped);
    expect(detail).not.toContain(attack);
    expect(detail).not.toContain("<script");
    expect(detail).not.toContain('method="post"');
    expect(detail).toContain(`/tasks/${dependency.id}?limit=10`);
    const comments = await (
      await get(nextPage(detail, "commentsCursor"))
    ).text();
    expect(comments).toContain("Second comment");
    const links = await (await get(nextPage(detail, "linksCursor"))).text();
    expect(links).toContain("Second link");
    const artifacts = await (
      await get(nextPage(detail, "artifactsCursor"))
    ).text();
    expect(artifacts).toContain("javascript:alert(1)");
    expect(artifacts).not.toContain('href="javascript:');
    expect(nextPage(detail, "eventsCursor")).toBeDefined();
  });

  it("allows an empty page size and respects read scopes and project visibility", async () => {
    const f = webFixture();
    const root = await f.app.request("/", { headers: f.headers });
    expect(await root.text()).toContain('name="limit" min="1" value=""');
    const privateProject = f.board.createProject(f.admin, {
      key: "PRIVATE",
      name: "Secret project",
    });
    const hidden = f.board.createTask(f.admin, {
      projectId: privateProject.id,
      title: "Secret task",
      accountable: f.owner.principal.id,
    });
    const secret = f.board.createToken(f.admin, {
      principalId: f.owner.principal.id,
      scopes: ["tasks:read"],
      projectIds: [f.project.id],
    }).secret!;
    const headers = { Authorization: `Bearer ${secret}` };
    expect(await (await f.app.request("/", { headers })).text()).not.toContain(
      "Secret project",
    );
    expect(
      (
        await f.app.request(`/?project=${privateProject.id}&limit=10`, {
          headers,
        })
      ).status,
    ).toBe(403);
    expect(
      (await f.app.request(`/tasks/${hidden.id}?limit=10`, { headers })).status,
    ).toBe(403);
    expect((await f.app.request("/?limit=0", { headers })).status).toBe(422);
    expect(
      (await f.app.request("/tasks/missing?limit=10", { headers })).status,
    ).toBe(404);
    const noRead = f.board.createToken(f.admin, {
      principalId: f.owner.principal.id,
      scopes: ["tasks:write"],
    }).secret!;
    expect(
      (
        await f.app.request("/", {
          headers: { Authorization: `Bearer ${noRead}` },
        })
      ).status,
    ).toBe(403);
  });
});
