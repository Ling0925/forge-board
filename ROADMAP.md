# forge-board 路线图

只写顺序，不写日期。跨仓依赖明确标出；forge-core 指 [Ling0925/forge-core](https://github.com/Ling0925/forge-core)。设计见 [docs/DESIGN.md](docs/DESIGN.md)，第 10 节为已确定的决策。

## 已完成

| 内容 | PR |
|---|---|
| 第 1 阶段：数据模型与状态机；原子认领、租约（默认不过期）、乐观版本、幂等；依赖 DAG 与 `ready` 查询；评论、产物、链接、标签；可配置的人工审批；身份、token 与 scopes；REST `/v1` 与 OpenAPI；SSE；MCP（Streamable HTTP + stdio 代理）；CLI；只读网页 | [#1](https://github.com/Ling0925/forge-board/pull/1) |

## 下一步（按顺序）

1. **为 forge-core 适配器补充 API**
   - 被依赖：forge-core 的 HTTP `WorkItemStore` 适配器（forge-core 路线图“下一步 1”）依赖这一项。
   - 内容（都是现有能力的补充，不新增限制）：
     - 状态转换时可以同时写 `progress`，一次请求原子完成；
     - 重复添加同一条链接时幂等返回，不再报冲突；
     - 删除链接时可以按 `kind + ref` 指定；
     - 任务响应可以选择内嵌链接（例如 `?include=links`）；
     - 列表查询支持多个状态，并支持按创建时间排序。
   - 规模：约 0.3–0.7k 行（含测试）。
2. **网页写操作与审批收件箱**
   - 内容：在网页上做状态转换、评论、认领和释放；审批收件箱（批准或拒绝）；通过 SSE 实时刷新。复用服务层现有的权限和版本校验。
   - 注意：`/v1` 只接受 Bearer token，网页用的是 cookie 登录，所以写操作需要自己的表单路由和 CSRF 防护。
   - 规模：约 0.9–1.5k 行。
3. **CI**
   - 草稿在本机 `/workspace/forge-board-ci.yml`（typecheck、lint、build、test）。
   - 依赖：一个带 `workflow` 权限的凭据。

## 之后

- Webhook 订阅：outbox 加 HMAC 签名，从事件表断点续发。需要先定投递和重试策略，约 0.9–1.5k 行。
- 全文搜索（SQLite FTS5）：需要先定搜索哪些字段、中文怎么分词，约 0.5–0.9k 行。
- GitHub 只读同步：需要先定凭据，以及状态以哪一边为准，约 0.9–1.5k 行。
- Postgres 后端；多 workspace 和团队；OAuth/OIDC 登录；按项目配置的转换规则。
- 可选：A2A 网关；与 GitHub Issues、Linear 双向同步；任务模板。

## 待你决定

1. **网页写操作的范围**：只做审批收件箱，还是同时开放状态转换、评论和认领。
2. **与 forge-core 的对接身份**：Forge 用一个 board 身份，还是每个 Worker 一个（每个都要有归属人）。
3. **两套审批**：board 的审批管任务状态转换，Super-agent 的发送队列审批管 GitHub 写操作。是否要在 board 里统一展示？
4. **之后各项的策略**：webhook 的重试策略、全文搜索的字段和中文分词方式、GitHub 同步时以哪一边的状态为准。
5. **CI 凭据**：给 gh token 加 `workflow` 权限，还是由你手动添加工作流文件。
