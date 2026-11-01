# forge-board

给 AI agent 和人共用的任务协作服务：通过 MCP 和 HTTP 认领、协作、交接任务。

一个 Node.js 进程提供 REST、MCP、SSE 和只读网页，数据保存在本地 SQLite。任务共享同一套权限、原子认领、租约、版本控制、幂等和人工审批规则。适合自托管，也可作为 Forge `WorkItemStore` 的远端后端；Forge 侧适配器不在本仓库。

## 安装与启动

需要 Node **>=22.23.1 <23**、pnpm **11.18.0**。从源码安装：

```sh
git clone https://github.com/Ling0925/forge-board.git
cd forge-board
pnpm install --frozen-lockfile
pnpm build
alias forge-board='node ./dist/cli.js'

forge-board init --data "$HOME/.forge-board" --name "我"
```

`init` 创建数据库、`config.json`、首个人类身份及管理员 token，只能执行一次。保存输出中的 `principal.id` 和 `secret`；token 明文仅在创建时返回，数据库只存哈希。以下变量请替换为实际输出：

```sh
DATA="$HOME/.forge-board"
ADMIN_TOKEN='<init 返回的 secret>'
OWNER_ID='<init 返回的 principal.id>'

forge-board project create --data "$DATA" --token "$ADMIN_TOKEN" \
  --key FORGE --name "开发看板" \
  --settings '{"approvalRequired":["in_review->done"]}'

PROJECT_ID='<project create 返回的 id>'
forge-board principal create --data "$DATA" --token "$ADMIN_TOKEN" \
  --kind agent --name "Worker A" --owner "$OWNER_ID"

AGENT_ID='<principal create 返回的 id>'
forge-board token create --data "$DATA" --token "$ADMIN_TOKEN" \
  --principal "$AGENT_ID" --scopes tasks:read,tasks:write,tasks:claim \
  --projects "$PROJECT_ID"

forge-board serve --data "$DATA" --port 8787
```

端口必须用 `--port` 或 `config.json` 指定，没有默认端口；默认监听 `127.0.0.1`，可用 `--host` 修改。远程部署放在 HTTPS 反向代理后。管理 CLI 直接访问 `--data` 指定的本地数据目录；远程管理使用 REST。

Scopes：`tasks:read`、`tasks:write`、`tasks:claim`、`tasks:assign`、`tasks:approve`、`projects:admin`、`tokens:admin`。token 可限定项目，创建时可用 `--expires-at <ISO 时间>` 设置过期时间，未设置则不过期。人也使用 token；可为网页单独创建 `tasks:read` token。

```sh
forge-board token list --data "$DATA" --token "$ADMIN_TOKEN" --limit 20
forge-board token revoke '<token id>' --data "$DATA" --token "$ADMIN_TOKEN"
```

## REST 与事件订阅

REST 位于 `/v1`，使用 `Authorization: Bearer <token>`。完整接口与 schema：`GET /v1/openapi.json`。

| 接口 | 用途 |
| --- | --- |
| `GET/POST /v1/projects`、`GET/PATCH /v1/projects/:id` | 项目及设置 |
| `GET/POST /v1/tasks`、`GET/PATCH /v1/tasks/:id` | 查询、创建、更新任务 |
| `POST /v1/tasks/:id/claim`、`POST /v1/tasks/claim-next` | 指定任务认领、从 ready 队列认领 |
| `POST /v1/tasks/:id/release`、`/reclaim`、`/lease/renew` | 释放、人类收回、续租 |
| `POST /v1/tasks/:id/transition` | 状态转换，审批策略可能返回 pending approval |
| `GET/POST /v1/tasks/:id/comments`、`/artifacts`、`/links` | 评论、产物、外部引用 |
| `GET/POST/DELETE /v1/tasks/:id/dependencies` | 依赖 DAG |
| `GET /v1/approvals`、`POST /v1/approvals/:id/decide` | 查询审批、人类决策 |
| `GET /v1/events` | 事件分页，或 SSE 订阅 |

列表必须传 `limit`，响应为 `{items, nextCursor}`；用 `cursor=nextCursor` 继续。任务可按 `project`、`status`、`assignee`、`label`、`link`、`parentId`、`ready=true` 过滤。`ready` 表示 todo、依赖全部完成且没有有效租约。

创建时可附带 `links` 和 `subtasks`，与父任务在同一事务内写入；返回父任务，子任务通过 `parentId` 查询。子任务继承项目和默认负责人，可单独指定人类 `accountable`。

```sh
URL=http://127.0.0.1:8787
AGENT_TOKEN='<agent token create 返回的 secret>'
curl "$URL/v1/tasks" \
  -H "Authorization: Bearer $AGENT_TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: work-item-1' \
  -d "{\"projectId\":\"$PROJECT_ID\",\"accountable\":\"$OWNER_ID\",\"title\":\"实现接口\",\"links\":[{\"kind\":\"thread\",\"ref\":\"forge:thread:thread-1\"}],\"metadata\":{\"forge\":{\"profileId\":\"worker\"}}}"

curl "$URL/v1/tasks?status=todo&link=forge%3Athread%3Athread-1&limit=20" \
  -H "Authorization: Bearer $AGENT_TOKEN"

curl -N "$URL/v1/events?project=$PROJECT_ID&after=0" \
  -H "Authorization: Bearer $AGENT_TOKEN" -H 'Accept: text/event-stream'
```

写入接受 `Idempotency-Key`：同一身份、同一 key、相同请求返回原响应，换请求返回 422。更新使用 `If-Match: "<version>"`，冲突返回 412 和最新任务。租约持有者写入必须带请求体 `leaseToken`；自己的进度和状态转换可省略版本，其他写入仍需版本。竞争认领只有一个成功，其他返回 409 `claim_conflict`；旧租约 token 写入返回 409 `lease_lost`。

SSE 的 `id` 是全局递增事件序号；用 `Last-Event-ID` 或 `after` 续传，前者优先。未带 SSE Accept 时，`/v1/events?limit=20` 返回游标分页 JSON。

## MCP 接入

使用官方 `@modelcontextprotocol/sdk`，同一服务的 `/mcp` 提供无状态 Streamable HTTP，每次请求用 Bearer 验证身份和 scopes。

| 工具 | 参数要点 |
| --- | --- |
| `board_list` | `limit`、`cursor`、`projectId`、`ready`、`status`、`link` 等过滤项 |
| `board_get` | `id`；可选 `comments`、`artifacts`、`links`、`dependencies`、`approvals`、`events`，各传 `{limit, cursor?}` |
| `board_create` | `projectId`、`title`、`accountable`，可选 `links`、`subtasks` 等 |
| `board_update` | `id` 和待更新字段，`expectedVersion` |
| `board_claim` | `{id}` 或 `{next:true, projectId}`；没有 ready 任务返回 null |
| `board_release` | `id`、`leaseToken` |
| `board_transition` | `id`、`to`、可选 `message` |
| `board_comment` | `id`、`kind`、`body`，回答用 `replyTo` 指向问题 |
| `board_artifact` | `id`、`name`、`mediaType`、`content: {uri, text:null}` 或 `{uri:null, text}` |
| `board_link` | `id`、`kind`、`ref`、可选 `title` |

所有变更工具接受可选 `idempotencyKey`，版本、租约规则与 REST 相同（参数 `expectedVersion`、`leaseToken`）。工具结果是 JSON 文本；领域错误返回 `isError: true` 和 `{error:{code,status,message,details}}`。`board_get` 返回 `{task, ...请求的关联分页}`，各分页有自己的 `nextCursor`。子任务用 `board_list` 的 `parentId` 查询。

支持 `mcpServers` 格式的客户端可配置 HTTP；具体字段以客户端为准：

```json
{
  "mcpServers": {
    "forge-board": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp",
      "headers": { "Authorization": "Bearer <agent token>" }
    }
  }
}
```

只支持 stdio 的客户端可运行代理。代理通过 SDK Client + Server 转发远端工具列表和调用，不打开数据库：

```json
{
  "mcpServers": {
    "forge-board": {
      "command": "node",
      "args": ["/absolute/path/forge-board/dist/cli.js", "mcp"],
      "env": {
        "FORGE_BOARD_URL": "http://127.0.0.1:8787",
        "FORGE_BOARD_TOKEN": "<agent token>"
      }
    }
  }
}
```

也可运行 `forge-board mcp --url <server> --token <token>`，命令行参数优先于环境变量。stdout 只输出 MCP 协议。

## 网页与人工审批

浏览器访问 `/`，在 `/ui/login` 的表单中提交 token。登录使用 POST 设置 HttpOnly、SameSite=Strict 的会话 cookie，HTTPS 下带 Secure；TLS 反向代理应覆盖设置 `X-Forwarded-Proto: https`。token 不放 URL，避免进入 URL 日志、历史记录或 Referer；页面使用 `Cache-Control: no-store` 和 `Referrer-Policy: no-referrer`。Cookie 仅用于网页认证，REST/MCP 始终要求 Bearer。

填写每页条数后选择项目，按状态列查看任务；配置了 `maxPageSize` 时用该值初始化表单。任务详情 `/tasks/:id` 展示字段、依赖、关联、产物、评论、审批及事件活动，各列表独立翻页。页面直接服务端渲染，用户内容全部转义，引用和产物 URI 作为文本展示。没有任务写入操作，手动刷新查看最新状态。

审批只能由有 `tasks:approve` 的人通过 REST 或 CLI 完成：

```sh
forge-board approvals list --data "$DATA" --token "$ADMIN_TOKEN" \
  --project "$PROJECT_ID" --state pending --limit 20
forge-board approvals approve '<approval id>' --data "$DATA" --token "$ADMIN_TOKEN" \
  --expected-version '<task version>' --idempotency-key '<unique key>'
# 拒绝时把 approve 改为 reject。
```

远程对应 `POST /v1/approvals/:id/decide`，请求体 `{"decision":"approved"}` 或 `{"decision":"rejected"}`，同时传 `If-Match`。审批通过与状态转换在同一事务内执行。

## 设置与决策

数据目录 `config.json` 的全局设置在进程启动时读取，修改后重启服务。项目设置在数据库中，可用 `project settings <id> --settings '<JSON>'` 或 `PATCH /v1/projects/:id` 的 `settings` 字段修改；提交的是整份项目设置。

| 设置 | 位置 | 未设置时 / 含义 |
| --- | --- | --- |
| `leaseTtl` | 项目 | 不过期；设置为正数毫秒后，持有者写入续租，读/认领时惰性检查过期并记录事件 |
| `approvalRequired` | 项目 | 无审批门禁；数组如 `["in_review->done", "*->canceled"]` |
| `allowAgentAssignment` | 项目 | false；开启后也只允许同一个 owner 下的 agent 互相指派，并需 `tasks:assign` |
| `idempotencyRetention` | config.json | 永久保留；设置为正数毫秒后，写入时惰性清理旧记录 |
| `maxPageSize` | config.json | 无最大值；设置为正整数以限制单个响应内存占用，超过时返回该大小的页面和续页游标 |
| `port` | config.json | 无默认值；可被 `serve --port` 覆盖 |

人和 agent 共用 Task；agent 必须有一个人类 owner，负责人 `accountable` 和审批人始终是人。状态为 `todo`、`in_progress`、`input_required`、`blocked`、`in_review`、`done`、`failed`、`canceled`；`ready` 是查询。`question` 评论会请求输入，指向问题的 `answer` 在任务等待输入时恢复 `in_progress`。依赖不能成环，产物按名称递增版本。默认无后台租约回收定时器；人类负责人、持有 agent 的 owner 或项目管理员可显式收回租约。

SQLite 事务统一处理领域规则和事件，REST/MCP 是薄封装；MCP 使用普通 tools，不使用 MCP Tasks 扩展。第 1 阶段只有一个 workspace，所有表预留 `workspace_id`。网页保持只读，审批走 CLI/REST。

## 开发与验收

```sh
pnpm typecheck
pnpm exec biome check --write .
pnpm lint
pnpm test
pnpm build
```

`tests/e2e.test.ts` 在临时数据目录和真实临时端口上验证 REST agent 与官方 SDK MCP client 的并发认领、问答、产物、交接、人工审批和 SSE 事件顺序；CLI 测试另行验证审批及 SDK stdio 代理。测试不使用真实用户数据或 token。

MIT License
