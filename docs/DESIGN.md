# Agent 任务协作平台：设计提案

> 只是设计，不建仓库、不写代码。工作名 **forge-board**（见第 9 节的决策 1）。
> 目标：一个独立服务，让 Forge 和非 Forge 的 agent（以及人）通过任务协作；接口是 MCP 和 HTTP。Forge Super-agent 的 `WorkItemStore` 以后可以把它当远程后端。

---

## 1. 调研结论

| 方案 | 要点 | 借鉴 | 避免 |
|---|---|---|---|
| [A2A Task](https://a2a-protocol.org/latest/specification/)（[生命周期](https://a2a-protocol.org/latest/topics/life-of-a-task/)） | Task 有 `id`、`contextId`、`status{state,message,timestamp}`、`artifacts`、`history`、`metadata`。状态：submitted、working、input-required、auth-required、completed、failed、canceled、rejected | **状态命名**和“中断态与终态”的区分；`contextId` 用来归组；产物和消息分开 | A2A 管的是“一个 agent 替另一个执行”的 RPC 语义，不涉及看板、多方认领或依赖。只对齐命名，不实现 A2A 协议本身（以后可以加一个 A2A 网关） |
| [MCP Tasks](https://modelcontextprotocol.io/extensions/tasks/overview)（2025-11-25 实验特性，已移到扩展 [SEP-1686](https://modelcontextprotocol.org/seps/1686-tasks)） | 让单次 MCP 请求变成“先拿句柄、之后再取结果” | 名字容易混淆，**不要**把协作任务做成 MCP Tasks；MCP 侧只用普通 tools | 依赖一个实验中、还在搬家的特性 |
| [Linear Agents](https://linear.app/developers/agents)（[设计文章](https://linear.app/now/our-approach-to-building-the-agent-interaction-sdk)） | agent 是工作区成员，可以被 @、被委派。**assignee 永远是人，agent 是 delegate**（“agent 不能被问责”）。AgentSession 有 pending、active、awaitingInput、error、complete、stale 状态；agent 的活动分为 thought、action、response、elicitation、error | **人负责、agent 执行**的双字段；活动流分类型；agent 发起的提问（elicitation）作为一等公民 | Linear 写死的响应时限（10 秒、30 分钟）。我们不内置这类时限 |
| [steveyegge/beads](https://github.com/steveyegge/beads)（MIT，Go，约 2.8 万星） | 给编程 agent 用、基于 git 的 issue 图，核心是“依赖感知的 ready 队列” | **`ready` 查询**（依赖都已完成、未被认领的任务）是 agent 最常用的入口 | 用 git/JSONL 当存储：多 agent 并发时合并冲突多，也没有原子认领 |
| [keshrath/agent-tasks](https://github.com/keshrath/agent-tasks)（MIT，TS） | MCP stdio + REST + WebSocket；分阶段流水线、依赖 DAG 与环检测、审批、产物版本、FTS5、看板 | 依赖 DAG 与环检测；评论线程；按阶段要求审批 | 阶段流水线是写死的；用心跳把“死掉的 agent”的任务自动判失败，这种隐式策略不要 |
| [waterworkshq/orcy](https://github.com/waterworkshq/orcy)（MIT，TS） | 事务性认领（一个认领只有一个赢家）、SSE、幂等写入、授权访问 | 事务认领、SSE、幂等键 | 功能面太大（22 个工具、规则引擎、时间追踪），还有“最多 2 次恢复”之类写死的上限 |
| [superagent-ai/zzboard](https://github.com/superagent-ai/zzboard)（MIT，TS） | `zz_claim_task`、`zz_heartbeat`、`zz_release_task`、`zz_create_subtask`、提交加验证；无状态 Streamable HTTP MCP，Bearer key | **claim、heartbeat、release 三件套**；无状态 HTTP MCP 加 Bearer | 托管和“工作网络”的定位，以及签名收据，第 1 阶段不需要 |
| [ahmad-codex/workstream-mcp](https://github.com/ahmad-codex/workstream-mcp)（MIT，C#） | 带 TTL 的原子认领、事件日志、同步 GitHub Projects | 事件日志作为事实来源 | 第 1 阶段不做外部同步 |
| Claude Code `TodoWrite` / Codex `update_plan` | 会话内的轻量清单：`{content, status: pending/in_progress/completed}` | 给 agent 的接口要**小**，状态要少，能批量更新 | 它们只在单个会话里，不持久，也不能多方协作；这正是本平台要补的 |
| GitHub Issues / Linear 直接给 agent 用 | 现成、可见 | 外部链接（`links` 指向 issue/PR） | 没有认领租约、乐观版本、幂等，也没有 agent 身份和权限范围 |
| DeepSeek《Super-agent 设计探索》 | Thread 与 Work Item 多对多；Router 与 Worker；明确授权 | **Thread 是外部引用，任务通过 link 订阅 Thread**；授权强度（明确/推断）记录在任务上 | — |

**许可**：以上项目都是 MIT。本设计**只借鉴概念，不复制代码**，所以不产生义务。如果以后要搬某段代码，需要保留它的 MIT 版权声明。

---

## 2. 架构

```
           ┌──────────── forge-board（单进程） ────────────┐
 agent ──MCP(Streamable HTTP / stdio 代理)──▶ MCP 层  ┐
 agent/人 ──REST /v1 ─────────────────────────▶ HTTP 层 ├─▶ service（领域规则、事务）─▶ repository ─▶ SQLite（以后 Postgres）
 UI/订阅者 ◀── SSE /v1/events ◀── 事件总线 ◀─────────┘                    └─▶ outbox ─▶ webhooks（第 2 阶段）
           └──────────────────────────────────────────────┘
```

- **一个领域层，两种接口**：MCP 工具只是领域服务的薄封装，与 REST 共用同一套校验、权限、版本和幂等逻辑。
- **事件日志是事实来源之一**：每次状态变化都在同一个事务里写进 `events` 表，并分配单调递增的 `seq`。SSE 和 webhook 都从这里读，可以用 `Last-Event-ID` 或 `?after=seq` 断点续传。
- **单进程、可自托管**：`npx forge-board serve` 或单个可执行文件，数据在一个目录里。MCP 有两种接入方式：远程 agent 用 Streamable HTTP（`/mcp`）；只会 stdio 的本地 agent 用一个 `forge-board mcp` 命令代理到 HTTP。

---

## 3. 数据模型

### 3.1 实体

| 实体 | 关键字段 |
|---|---|
| **Workspace**（租户边界） | id, name。第 1 阶段只有一个，但所有表都带 `workspace_id`，方便以后做多租户 |
| **Project**（看板） | id, key（例如 `FORGE`）, name, settings（租约时长、审批策略、允许的状态） |
| **Principal**（身份） | id（`usr_…` / `agt_…`）, kind: `human`\|`agent`, name, owner（agent 归哪个人，**agent 必须有归属人**）, disabled |
| **Token** | id, principal_id, hash（只存哈希）, scopes, project 范围, created_at, expires_at（可选，由创建者设置）, last_used_at |
| **Task** | 见 3.2 |
| **Dependency** | task_id → depends_on_id（DAG，写入时做环检测） |
| **Link** | task_id, kind（`thread`、`session`、`pr`、`issue`、`url`、`task`）, ref（例如 `gh:owner/repo#12`、`forge:session:<id>`）, title |
| **Comment** | id, task_id, author, body（Markdown）, kind: `comment`\|`question`\|`answer`\|`decision`, reply_to |
| **Artifact** | id, task_id, author, name, media_type, uri 或 inline 文本, version |
| **Label** | project 内的标签，多对多 |
| **Approval** | id, task_id, action（`complete`、`assign`、`external`……）, requested_by, state: pending/approved/rejected, decided_by |
| **Event** | seq（全局单调）, workspace_id, task_id?, type, actor, data(JSON), at |
| **IdempotencyRecord** | principal_id, key, request_hash, response, created_at |

### 3.2 Task

```jsonc
{
  "id": "tsk_01J…",            // ULID，稳定、可排序；对外还有 "FORGE-123" 这样的可读编号
  "projectId": "prj_…",
  "number": 123,
  "title": "…", "description": "…(Markdown)",
  "status": "todo",            // 见 3.3
  "statusMessage": "…",        // 对应 A2A 的 status.message
  "accountable": "usr_…",      // 负责人：只能是人（借鉴 Linear）
  "assignee": "agt_…",         // 执行者：人或 agent，可以为空
  "lease": { "holder": "agt_…", "token": "lse_…", "expiresAt": "…" } | null,
  "parentId": "tsk_…" | null,  // 子任务
  "priority": 0,
  "labels": ["…"],
  "authorization": "explicit" | "inferred" | null,  // 来自 Super-agent 的授权强度
  "progress": "…",             // 最新进度一句话（对应 Forge 的 WorkItem.progress）
  "metadata": {},              // 调用方自定义，例如 forge.profileId、worktree
  "version": 7,                // 乐观并发
  "createdBy": "…", "createdAt": "…", "updatedAt": "…"
}
```

### 3.3 状态生命周期（命名对齐 A2A，并加入看板语义）

```
todo ─claim─▶ in_progress ─▶ in_review ─(批准)─▶ done
  ▲              │  ▲  │
  │              │  │  └─▶ input_required ─(回答)─┘
  │              │  └──── blocked（依赖未完成或外部阻塞）
  └─release/租约过期┘
任意非终态 ─▶ canceled（人或负责人）     in_progress ─▶ failed
终态：done / failed / canceled；“重开”就是回到 todo，并记录一条事件
```

- `ready` 不是一个状态，而是一个**查询**：`status=todo`、依赖全部是 `done`、并且没有有效租约。
- 项目可以配置“哪些转换需要审批”，例如 `in_review→done` 必须由人批准。

---

## 4. 并发正确性

1. **原子认领**：`POST /tasks/{id}/claim`，用一条带条件的 UPDATE 实现：`WHERE id=? AND status IN ('todo') AND (lease IS NULL OR lease.expires_at < now)`。返回 1 行就是赢家，拿到新的 `lease.token`；0 行返回 `409 claim_conflict`，附上当前持有者。`claim-next`（从 ready 队列取一个并认领）在同一个事务里完成。
2. **租约与续租**：认领得到 `expiresAt = now + project.settings.leaseTtl`。
   - **为什么需要这个设置**：平台无法知道远端 agent 是否已经崩溃，租约是唯一能在“不靠写死超时”的前提下回收任务的机制。
   - 默认值写进设置并附上理由。建议默认 **15 分钟**，与常见 agent 单步工具调用的长度同一个数量级；用户可以按项目改。设成 `null` 表示永不过期（适合人）。
   - 续租：`POST /tasks/{id}/lease/renew` 带上 lease token；租约持有者的**任何写操作都会顺带续租**，所以活跃的 agent 不需要专门发心跳。
   - 过期**不会**自动把任务判成失败，只是让任务重新可被认领，并记一条 `lease_expired` 事件。原来的持有者再用旧 token 写入会收到 `409 lease_lost`。
   - 过期判断是**惰性**的：在认领或读取时比较时间，不需要后台扫描定时器；事件在下一次访问时补记。
3. **乐观版本**：每次修改都带 `If-Match: <version>`（MCP 工具里是 `expectedVersion` 参数），不匹配返回 `412`，并带回最新的 Task。持有租约的执行者写自己任务的进度时可以省略版本，因为租约本身已经保证了独占。
4. **幂等键**：所有创建和变更类请求都接受 `Idempotency-Key`。按（principal, key）保存请求哈希和响应：同一个 key、同样的请求，返回原响应；同一个 key、不同的请求，返回 `422`。保存多久做成设置 `idempotency.retention`，理由是要覆盖客户端可能重试的时间窗口，默认 **24 小时**（与 Stripe 等常见做法一致），可以改。
5. **事件顺序**：`events.seq` 在同一个事务里分配，SSE 按 seq 推送，订阅者可以无损续传。

---

## 5. 身份、权限与人的监督

- **Token**：每个 agent 一个或多个 token，只存哈希，可以撤销，`expires_at` 由创建者设置（可为空）。人在第 1 阶段也用 token（加 CLI 登录）；OAuth/SSO 放到后面。
- **Scopes**：`tasks:read`、`tasks:write`、`tasks:claim`、`tasks:assign`、`tasks:approve`、`projects:admin`、`tokens:admin`，并且可以限定到某些项目。
- **规则（服务端强制，不靠提示词）**：
  - agent **不能**批准审批，也不能当 `accountable`；
  - agent 只能把任务指派给自己，或指派给同一个归属人名下、并且自己有 `tasks:assign` 的 agent。是否允许“agent 指派给别的 agent”是一个项目设置，默认关闭；
  - 项目可以要求某些转换（例如完成、取消）或某些外部动作必须经过人批准；
  - 每个事件都记录 actor，agent 的事件还附上它的归属人。

---

## 6. 接口

### 6.1 REST（`/v1`，JSON，Bearer）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/projects`，`/projects/{id}` | 项目 |
| GET | `/tasks?project=&status=&assignee=&label=&link=&ready=true&cursor=` | 列表和查询（`link=gh:owner/repo#12` 按 Thread 查） |
| POST | `/tasks` | 创建，支持 Idempotency-Key |
| GET/PATCH | `/tasks/{id}` | 读取；更新时用 If-Match |
| POST | `/tasks/{id}/claim` · `/claim-next` · `/lease/renew` · `/release` | 认领、租约 |
| POST | `/tasks/{id}/transition` `{to, message}` | 状态转换，服务端校验 |
| POST/DELETE | `/tasks/{id}/links`，`/dependencies`，`/labels` | 关联 |
| POST/GET | `/tasks/{id}/comments`，`/artifacts` | 评论、产物 |
| POST | `/approvals/{id}/decide` | 人审批 |
| GET | `/events?after=seq`（SSE：`Accept: text/event-stream`，支持 `Last-Event-ID`） | 订阅 |
| POST | `/webhooks`（第 2 阶段） | 推送订阅，带 HMAC 签名，从 outbox 发出 |

所有列表用游标分页，**不设固定的 page 上限**，`limit` 由调用方给（服务端可以有一个设置化的最大值，理由是防止一次响应占用过多内存）。

### 6.2 MCP 工具（工具少而粗，借鉴 TodoWrite 的“小接口”）

- `board_list`（含 `ready`）、`board_get`
- `board_create`（支持一次建多个子任务）、`board_update`
- `board_claim`（可以指定 id，也可以 `next: true`）、`board_release`、`board_transition`
- `board_comment`（`question` 类型会把任务置为 `input_required`）、`board_artifact`、`board_link`

MCP 资源可以作为可选项：`board://task/{id}`。服务是无状态的 Streamable HTTP，用 Bearer token 认证，与 zzboard 的做法一致。

### 6.3 Forge `WorkItemStore` 适配器（在 forge-core 里，第 1 阶段一起交付）

| WorkItemStore | forge-board |
|---|---|
| `create({title, brief, threadIds, profileId})` | `POST /tasks`：`description=brief`、`links=[{kind:"thread"}…]`、`metadata.forge.profileId`，`Idempotency-Key` 由 Forge 生成 |
| `claim(id, claimedBy)` | `POST /tasks/{id}/claim`，适配器保存 lease token，Worker 每次写入都会顺带续租 |
| `update(id, {status, progress})` | 转换状态加更新 `progress`，按下面的映射 |
| `linkThread` / `unlinkThread` | `POST/DELETE /tasks/{id}/links`（kind=`thread`） |
| `linkWorker(id, sessionId, worktree)` | link kind=`session`，ref=`forge:session:<id>`；`metadata.forge.worktree` |
| `get` / `list({status, threadId})` | `GET /tasks/{id}` / `GET /tasks?status=&link=` |

状态映射（Forge → 平台）：
- `queued` → `todo`
- `running` → `in_progress`
- `waiting` → `input_required`
- `ready` → `in_review`
- `blocked` → `blocked`
- `failed` → `failed`
- `stopped` → `canceled`
- `done` → `done`

需要注意：PR #9 里留下的 “Work → Router 映射在本地 cursors 表” 这一项，迁移时改为放进 `metadata.forge.routerSessionId`。Forge 侧仍然只依赖 `WorkItemStore` 这个窄接口，不新增抽象层。

---

## 7. 技术栈与部署

- **语言和工具链**：TypeScript ESM、Node 22、pnpm、Vitest、Biome、esbuild，与 forge-core 一致。
- **HTTP 框架**：推荐 **Hono**。它很轻，对 SSE 支持好，也能跑在 Node 上；也可以直接用 `node:http`，但路由和中间件要自己写。
- **MCP**：官方 `@modelcontextprotocol/sdk` 的 Streamable HTTP 服务端。
- **校验**：zod，同一份 schema 同时生成 REST 的 OpenAPI 和 MCP 的 inputSchema。
- **存储**：第 1 阶段用 SQLite（`node:sqlite`，与 forge-core 相同，没有原生依赖），开启 WAL，单写者事务。在 repository 层只写可移植的 SQL：条件 UPDATE 认领、`RETURNING`、JSON 列。第 3 阶段增加 Postgres 实现，把认领改成 `UPDATE … WHERE … RETURNING` 或 `SELECT … FOR UPDATE SKIP LOCKED`。**不引入 ORM**；迁移用编号的 SQL 文件。
- **部署形态**：
  - 本地：`forge-board serve --data ~/.forge-board`，默认只监听 127.0.0.1；
  - 你自己的服务器：同一个进程，放在反向代理（TLS）后面；或者用一个 Dockerfile（Node 22 slim）；
  - 单文件发布：esbuild 打包成一个 `.mjs`；如果要真正的单二进制，以后用 Node SEA。
- **UI**：见第 9 节的决策 6。

---

## 8. 分阶段

| 阶段 | 内容 | 规模（含测试） |
|---|---|---|
| **P1 MVP** | 单 workspace；Project、Task、Dependency、Link、Comment、Artifact、Label；状态机；原子认领、租约（惰性过期）、乐观版本、幂等；agent 和人的 token 与 scopes；归属人；“完成需人批准”的审批；事件日志加 SSE；REST 和 MCP（Streamable HTTP 加 stdio 代理）；CLI（`serve`、`token create`、`project create`）；OpenAPI。**另做 forge-core 里的 `WorkItemStore` HTTP 适配器**，加一个设置项切换本地或远程。验收：Forge Super-agent 和一个外部 MCP agent（例如 Claude Code 或 Codex）在同一个项目里认领、协作、交接任务的端到端测试 | 服务约 5–7k 行；forge-core 适配器约 0.6–1k 行（单独一个 PR） |
| **P2** | 最小 Web UI（看板、任务详情、审批收件箱、实时 SSE）；webhook 订阅（outbox 加 HMAC）；全文搜索（SQLite FTS5）；GitHub 链接预览和状态同步（只读） | 约 3–4k 行 |
| **P3** | Postgres 后端；多 workspace 和团队；OAuth/OIDC 给人登录；按项目的转换规则配置 | 约 3–5k 行 |
| **P4（可选）** | A2A 网关（把 Task 暴露为 A2A Task）；GitHub Issues 和 Linear 双向同步；任务模板 | 视需要而定 |

---

## 9. 需要你拍板的决策

1. **仓库名**：推荐 `forge-board`，和 forge 系列保持一致，同时又不绑定 Forge（它本身是通用服务）。备选：`agent-board`、`taskmesh`。
2. **许可证**：forge-core 目前也没有许可证。推荐两个仓库**都用 Apache-2.0**：比 MIT 多了明确的专利授权，适合给第三方 agent 集成的服务；如果你更想简单，用 MIT 也可以。需要你选；在你选之前我不会加 LICENSE。
3. **托管**：推荐**先本地或你自己的服务器**（单进程加反向代理）。不做 SaaS，也不依赖任何云服务。
4. **人和 agent 是否共用一个任务模型**：推荐**共用**。同一个 Task，人和 agent 都是 Principal。但要加 Linear 式的约束：`accountable` 只能是人，agent 只能当 `assignee` 或执行者，审批只能由人做。
5. **认证模型**：推荐 P1 用**每个 agent 独立的 Bearer token，加 scopes、项目范围和归属人**；人也先用 token。OAuth/OIDC 放到 P3。
6. **P1 要不要 UI**：推荐**不要**。P1 先做 API、MCP、CLI 加 SSE，审批通过 CLI 或 REST 完成；P2 再做最小看板 UI。这样 P1 能更快接上 Forge 和一个外部 agent。如果你希望 P1 就能“看得见”，可以加一个只读的简易页面（约 0.5k 行）。
7. **多租户和团队**：推荐**P1 不做，但数据模型预留 `workspace_id`**，P3 再开启。你目前是个人使用，过早做多租户会拖慢 MVP。
8. **（附加）租约默认时长**：建议默认 15 分钟，按项目可改，可以设为不过期；理由见第 4 节。需要你确认，或者给出你的默认值。
9. **（附加）agent 能否把任务指派给其他 agent**：推荐默认**关闭**，在项目设置里打开。打开后仍然只允许指派给同一个归属人名下的 agent。

---

## 10. 已确定的决策（2026-10-31，以此为准）

- 仓库 `Ling0925/forge-board`，公开，MIT（© 2026 Ling0925）。
- 第 1 阶段包含一个**只读**网页（看板、任务列表、任务详情和活动记录），由同一个进程提供；UI 不能写入，审批仍然走 CLI 或 REST。
- **租约默认不过期**。租约时长是项目的可选设置；不设时，认领一直有效，直到释放、完成、取消，或由人/归属人显式收回。原子认领、版本、幂等的语义不变。
- agent 之间互相指派**默认关闭**；项目设置可以打开，打开后也只允许在同一个归属人名下的 agent 之间指派。
- 人和 agent 共用一个任务模型，负责人和审批人始终是人；每个 agent 一个 token，带 scopes、项目范围和归属人，人在 P1 也用 token；不做多租户，但预留 `workspace_id`；本地或自托管。
- 第 4 节里“租约默认 15 分钟”、第 9 节里推荐 Apache-2.0 的说法，以本节为准。
