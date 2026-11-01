import { type Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import {
  type Actor,
  BoardError,
  type Page,
  pageSchema,
  statusSchema,
} from "../domain/index.js";
import type { createBoard } from "../service/index.js";

const cookieName = "forge_board_token";
const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
const pre = (value: unknown) =>
  `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
const href = (path: string, query: Record<string, string>) =>
  escapeHtml(`${path}?${new URLSearchParams(query)}`);

function document(title: string, content: string) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · forge-board</title>
<style>
body{font-family:system-ui,sans-serif;margin:2rem;color:#202a33;background:#f5f7fa}
a{color:#1557a0}header,nav{margin-bottom:1rem}section,article{background:white;padding:1rem;border:1px solid #dae0e7;border-radius:.4rem;margin-bottom:1rem}
.board{display:flex;gap:1rem;overflow-x:auto}.column{flex:1;min-width:15rem}.column article{background:#f5f7fa}
pre{white-space:pre-wrap;overflow-wrap:anywhere}dt{font-weight:600}dd{margin:0 0 1rem}input,button{font:inherit;padding:.4rem}h1,h2,h3{overflow-wrap:anywhere}
</style></head><body><header><a href="/">forge-board</a> · 只读看板</header><main><h1>${escapeHtml(title)}</h1>${content}</main></body></html>`;
}

function pageForm(limit: number | undefined, project?: string) {
  return `<form method="get"><label>每页条数 <input type="number" name="limit" min="1" required value="${limit ?? ""}"></label>
${project === undefined ? "" : `<input type="hidden" name="project" value="${escapeHtml(project)}">`} <button type="submit">查看</button></form>`;
}

function next(
  c: Context,
  cursorKey: string,
  cursor: string | null,
  limit: number,
) {
  if (cursor === null) return "";
  const { token: _, ...current } = c.req.query();
  const query = { ...current, limit: String(limit), [cursorKey]: cursor };
  return `<p><a href="${href(c.req.path, query)}">下一页</a></p>`;
}

export function createWebApp(board: ReturnType<typeof createBoard>) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    await next();
  });
  app.get("/ui/login", (c) =>
    c.html(
      document(
        "登录",
        `<form method="post" action="/ui/login">
<label>访问 token <input type="password" name="token" required autocomplete="off"></label> <button type="submit">登录</button></form>`,
      ),
    ),
  );
  app.post("/ui/login", async (c) => {
    const { token } = z
      .strictObject({ token: z.string() })
      .parse(await c.req.parseBody());
    const actor = board.verifyToken(token);
    board.getWorkspace(actor);
    setCookie(c, cookieName, token, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
      secure:
        new URL(c.req.url).protocol === "https:" ||
        c.req.header("X-Forwarded-Proto") === "https",
    });
    return c.redirect("/", 303);
  });

  function actor(c: Context): Actor | null {
    const authorization = c.req.header("Authorization");
    const bearer = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
    if (authorization !== undefined && !bearer?.[1])
      throw new BoardError("unauthorized", "A Bearer token is required");
    const token = bearer?.[1] ?? getCookie(c, cookieName);
    return token === undefined ? null : board.verifyToken(token);
  }
  function pageLimit(c: Context) {
    const input = c.req.query("limit");
    return input === undefined
      ? board.settings.maxPageSize
      : pageSchema.shape.limit.parse(Number(input));
  }
  function page(c: Context, limit: number, cursorKey: string) {
    return pageSchema.parse({ limit, cursor: c.req.query(cursorKey) });
  }

  app.get("/", (c) => {
    const viewer = actor(c);
    if (viewer === null) return c.redirect("/ui/login");
    board.getWorkspace(viewer);
    const limit = pageLimit(c);
    const projectId = c.req.query("project");
    let content = pageForm(limit, projectId);
    if (limit === undefined) return c.html(document("项目", content));
    const projects = board.listProjects(
      viewer,
      page(c, limit, "projectsCursor"),
    );
    content += `<nav><h2>项目</h2><ul>${projects.items
      .map(
        (project) =>
          `<li><a href="${href("/", { project: project.id, limit: String(limit) })}">${escapeHtml(project.key)} · ${escapeHtml(project.name)}</a></li>`,
      )
      .join(
        "",
      )}</ul>${next(c, "projectsCursor", projects.nextCursor, limit)}</nav>`;
    if (projectId !== undefined) {
      const project = board.getProject(viewer, projectId);
      const tasks = board.listTasks(viewer, {
        ...page(c, limit, "tasksCursor"),
        projectId,
      });
      content += `<h2>${escapeHtml(project.name)}</h2><div class="board">${statusSchema.options
        .map(
          (status) =>
            `<section class="column"><h3>${escapeHtml(status)}</h3>${tasks.items
              .filter((task) => task.status === status)
              .map(
                (task) =>
                  `<article><a href="${href(`/tasks/${encodeURIComponent(task.id)}`, { limit: String(limit) })}">${escapeHtml(project.key)}-${task.number} ${escapeHtml(task.title)}</a><p>${escapeHtml(task.progress)}</p></article>`,
              )
              .join("")}</section>`,
        )
        .join("")}</div>${next(c, "tasksCursor", tasks.nextCursor, limit)}`;
    }
    return c.html(document("项目看板", content));
  });

  app.get("/tasks/:id", (c) => {
    const viewer = actor(c);
    if (viewer === null) return c.redirect("/ui/login");
    const task = board.getTask(viewer, c.req.param("id"));
    const limit = pageLimit(c);
    let content = `<section><h2>字段</h2><dl>${Object.entries(task)
      .map(
        ([key, value]) =>
          `<dt>${escapeHtml(key)}</dt><dd>${typeof value === "string" ? `<pre>${escapeHtml(value)}</pre>` : pre(value)}</dd>`,
      )
      .join("")}</dl></section>${pageForm(limit)}`;
    if (limit !== undefined) {
      content = `<nav><a href="${href("/", { project: task.projectId, limit: String(limit) })}">返回项目</a></nav>${content}`;
      const section = <T>(
        title: string,
        cursorKey: string,
        data: Page<T>,
        render: (item: T) => string = pre,
      ) =>
        `<section><h2>${title}</h2>${data.items.map((item) => `<article>${render(item)}</article>`).join("")}${next(c, cursorKey, data.nextCursor, limit)}</section>`;
      content += section(
        "依赖",
        "dependenciesCursor",
        board.listDependencies(
          viewer,
          task.id,
          page(c, limit, "dependenciesCursor"),
        ),
        (dependency) =>
          `<a href="${href(`/tasks/${encodeURIComponent(dependency.dependsOnId)}`, { limit: String(limit) })}">${escapeHtml(dependency.dependsOnId)}</a>`,
      );
      content += section(
        "关联",
        "linksCursor",
        board.listLinks(viewer, task.id, page(c, limit, "linksCursor")),
      );
      content += section(
        "产物",
        "artifactsCursor",
        board.listArtifacts(viewer, task.id, page(c, limit, "artifactsCursor")),
      );
      content += section(
        "评论",
        "commentsCursor",
        board.listComments(viewer, task.id, page(c, limit, "commentsCursor")),
      );
      content += section(
        "审批",
        "approvalsCursor",
        board.listApprovals(viewer, task.id, page(c, limit, "approvalsCursor")),
      );
      content += section(
        "活动",
        "eventsCursor",
        board.listEvents(viewer, {
          ...page(c, limit, "eventsCursor"),
          taskId: task.id,
        }),
      );
    }
    return c.html(document(task.title, content));
  });
  return app;
}
