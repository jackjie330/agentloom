# 企业 AI Agents 后端：仓库初始化与分步实施计划

> 本文定义首版范围、实施顺序和验收标准；各阶段完成情况以第 5 节验收记录为准。
> 技术方向：TypeScript + Deep Agents SDK + PostgreSQL + Docker。

## 1. 目标与范围

交付一个可认证、可持久化、可流式交互的 Agent 后端：

- 创建和查询所属会话，运行最小 Deep Agent。
- 查询会话最新保存的状态与结果，支持显式继续未完成的工作。
- 校验可信身份，隔离不同租户及用户的数据。
- 限制每次调用的模型与工具调用次数，支持超时、取消和脱敏错误响应。
- 对指定工具提供人工审批（HITL），支持批准、拒绝及重启后的审批恢复。
- 通过 SSE 返回消息增量、工具状态、待审批信息和执行结果。
- 支持本地开发、Docker 部署和不依赖真实模型的自动化测试。

首版不实现逐次执行记录与结果归档、历史快照浏览、外部追踪、自动恢复调度、任务队列、SSE 事件重放、长期记忆、Agent 安全沙箱、任意代码执行、微服务或向量数据库，不为这些能力预建接口。

人工审批只覆盖会话所属用户对指定工具调用的批准与拒绝，不做独立审批角色、多级审批、通知或参数编辑。Checkpoint 不代表自动恢复，普通 Docker 容器不代表 Agent 安全沙箱。

## 2. 实现约束

### 2.1 技术选型与 KISS 原则

| 领域           | 采用方案                                                         |
| -------------- | ---------------------------------------------------------------- |
| 运行时与包管理 | Node.js 24 LTS、pnpm；初始化时固定具体版本并提交锁文件           |
| 语言与构建     | TypeScript、ESM；`tsx` 开发，`tsc` 编译，Node.js 运行生产产物    |
| HTTP           | Fastify，使用内置 Pino 日志能力                                  |
| Agent          | Deep Agents JS/TS SDK、默认 StateBackend、官方 interrupt/HITL    |
| 数据库         | PostgreSQL、`pg.Pool`、Drizzle ORM、官方 PostgreSQL checkpointer |
| 校验           | Zod，校验配置、请求和工具参数                                    |
| 测试与检查     | Vitest、ESLint、Prettier、TypeScript 类型检查                    |
| 部署与 CI      | Docker、Docker Compose；使用 GitHub 时采用 GitHub Actions        |

以上是本项目选型，不是 SDK 强制要求。实现遵循以下规则：

- **单体、单进程**：首版只有一个 API 执行进程，不支持 cluster、多 worker 或多副本同时执行。
- **只建当前需要的代码**：路由处理 HTTP，业务函数处理执行与归属校验，直接使用 Drizzle；不要求每个功能都具备 controller/service/repository 等固定分层。
- **复用已有能力**：执行直接调用 SDK，不重写其规划、上下文管理、checkpoint 或审批机制；不建立执行引擎、调度器、通用 Repository、认证插件框架或事件总线。
- **一种需求只有一条首版路径**：一种生产认证方式、一套 PostgreSQL 环境、一套迁移入口、一种执行流式方式。不为可能的替换提前建立适配层。
- **按需拆分**：先使用具体函数和少量文件，出现实际重复或文件职责过多时再提取公共代码；不预建空目录、接口或配置开关。

### 2.2 数据与持久化

开发、本地运行、CI 和生产均使用 PostgreSQL；本地通过 Docker Compose 提供，不支持数据库后端切换。Drizzle 和官方 checkpointer 共用一个 PostgreSQL 实例及一个 `pg.Pool`，由应用统一关闭连接池。

| 数据                                   | 唯一管理者                           |
| -------------------------------------- | ------------------------------------ |
| 会话归属、关闭标记、最小审批审计       | Drizzle 业务表                       |
| 会话消息、图状态、待审批中断、恢复位置 | 官方 checkpointer，通过 SDK API 访问 |

会话表只保存会话 ID、所属租户和用户、必要时间字段及 `closedAt`。审批审计随 Step 5 加入，不在业务表复制消息、结果、工具轨迹或 SDK 执行状态，不保存调用计数或 checkpoint 引用。首版不建设租户、用户管理 CRUD，不提前设计完整平台 schema。

会话状态与结果统一通过 `agent.getState({ configurable: { thread_id: conversationId } })` 查询。`StateSnapshot` 的 `values`、`next` 和 `tasks` 用于读取最新保存的内容、未完成任务与审批中断；当前进程是否仍有调用，由进程内活跃调用表判断。接口只返回经过授权和筛选的会话内容及必要状态，不返回完整图状态。查询不会执行节点，不直接读写 checkpointer 内部表，不另建 checkpoint 管理器或结果存储。

查询表示“会话最后保存了什么”，不是某次 HTTP 提交的受理或完成凭证。进程在输入保存前中断时，查询可能仍显示之前的内容或空状态；不据此宣称该输入已完成或模型、工具从未执行过，也不自动重新提交输入。没有可继续的持久化任务时，显式继续接口返回明确错误。

业务表与 checkpoint 不要求原子提交，也不做启动扫描或状态对账。启动不执行 Agent；查询、提交输入、显式继续和审批时，按需读取 SDK 快照。会话关闭标记用于禁止后续执行，不修改或清除图状态。

数据库准备只有 `pnpm db:migrate` 一个入口：串行执行 Drizzle 迁移和 saver 的 `setup()`。`pnpm db:generate` 只生成业务迁移；不复制 SDK 内部表定义，不在 API 启动时自动迁移。

### 2.3 会话与执行

会话是唯一的对外业务资源。服务端生成 `conversationId`，直接用作 SDK 的 `thread_id`；所有输入、查询、继续、审批和取消操作都以会话为入口。

每个会话最多一个活跃调用，不排队。查询始终需要归属校验，其他操作按下表从上至下匹配第一项：

| 条件                     | 允许的操作                               |
| ------------------------ | ---------------------------------------- |
| 会话已关闭               | 只读查询；重复取消不重复执行任何工作     |
| 当前进程仍有活跃调用     | 取消；拒绝新的输入、继续和审批决策       |
| SDK 快照有待审批中断     | 提交审批决策或取消；普通继续不能绕过审批 |
| SDK 快照有其他未完成任务 | 显式继续或取消；拒绝新输入               |
| 无活跃调用、无未完成任务 | 提交新输入或取消；新输入保留已有会话历史 |

执行统一使用 SDK 的原生入口。下表的 `config` 使用会话 `thread_id` 并传入可信 context、取消信号等运行配置：

| 操作               | SDK 用法                                                               |
| ------------------ | ---------------------------------------------------------------------- |
| 提交新输入         | `agent.stream(input, config)`，由 SDK 将输入合入保存的状态并从入口开始 |
| 显式继续未完成任务 | `agent.stream(null, config)`，由 SDK 加载最新 checkpoint               |
| 提交人工审批决策   | `agent.stream(new Command({ resume: { decisions } }), config)`         |

继续与审批不接收新输入，恢复位置由 SDK 处理。不传历史 `checkpoint_id` 执行，不提供历史重放、分叉或图状态编辑。

每次 SDK 调用分别设置模型调用上限、工具调用上限和活跃超时；显式继续与审批后的调用使用新的限额和计时。等待审批时调用已经结束，不计时、不占用模型或数据库连接。首版限制单次调用，不承诺跨请求、跨重启的累计额度或费用上限，不持久化预算计数。

超时、触发上限、调用错误或活跃断线使本次调用结束或进入停止流程；没有关闭会话且 SDK 留有未完成任务时，用户可以在活跃调用结束后显式继续。该操作可能重新执行尚未保存完成的工作，不保证节点、模型或工具只调用一次；不自动重试或补跑。

使用具体函数处理调用、流和取消，在进程内按 `conversationId` 保存 `AbortController` 与调用结束信号。入口复用短时并发保护，检查会话是否关闭、SDK 快照及是否已有活跃调用，并在释放保护前登记本次调用；不在模型或工具执行期间持锁。活跃记录在调用实际结束后移除，停止请求不能提前释放互斥。不同会话不共用用户状态或凭证。

### 2.4 SSE 与取消

提交新输入、显式继续和审批决策的请求直接返回本次调用的 SSE；查询与取消使用普通 HTTP 接口。不增加独立订阅接口、后台执行或事件存储；浏览器可用 `fetch` 消费流。

SDK 原生流只映射为消息增量、工具状态、调用结束、待审批、完成与错误等必要事件，不宣称自定义协议兼容官方 `useStream`。流中的增量不等同于已持久化内容，断线后的查询以 SDK 保存的状态为准。

- 超时、触发上限或活跃断线触发协作式停止，不关闭会话。连接关闭、发出停止信号不代表执行已停止；活跃调用实际结束前仍拒绝其他执行请求。
- 显式取消表示关闭会话：在短时并发保护下先持久化 `closedAt`，再通知活跃调用停止。关闭后不可提交输入、继续或审批，重启也不能重新执行；需要新工作时创建新会话，已有内容仍可查询。
- 关闭成功只保证禁止后续调用，不撤销已发生的模型或工具调用，也不代表在途工作已停止。取消响应和查询分别说明会话是否关闭、当前进程是否仍有活跃调用，不提前宣称停止成功；关闭写入失败时明确报错。
- 待审批中断持久化后发送待审批事件并正常关流，该关闭不取消审批，也不要求客户端保持连接。
- 断线后先查询会话，不重放增量、不自动重新提交；是否可显式继续或审批按第 2.3 节判断。未收到待审批事件也能通过查询发现审批。

### 2.5 安全与检查

- 生产认证选择一种可信凭证验证方式，写明凭证来源及租户、用户标识的验证规则；不接受请求体中的身份声明。开发测试身份只能显式启用，生产拒绝该模式。
- 会话的输入、查询、继续、审批、取消及 SSE 一律校验所属租户和用户；资源标识不是访问凭证。
- 默认不提供 Shell、任意代码执行或宿主机文件访问；不启用外部追踪或向追踪平台上传运行数据。
- 日志关联 `requestId`、`conversationId`，脱敏认证信息和错误；不记录完整提示词或工具结果，不通过 SSE 暴露内部状态或密钥。错误响应带请求标识，SDK 快照中的错误只返回必要的脱敏摘要，不保存逐次调用错误历史。
- 测试只维护一套可复用 fake 模型和工具辅助代码。单元测试覆盖纯逻辑及 SDK 最小用法，集成测试用真实 PostgreSQL 验证 HTTP、持久化和恢复；不建设自有模型模拟框架。
- 按可观察行为验收，不为每个函数重复写单元、集成、端到端三套测试，不设机械覆盖率门槛。权限隔离、调用级限制、重复审批和取消竞态仍须确定性验证；用可控信号协调测试，不靠长时间等待碰运气。
- 普通测试和 CI 不需要真实模型 Key。真实模型仅作可选 smoke test，不增加生产 fake 模型开关。

## 3. 分步实施与验收

按 Step 1–6 推进，每步可以依赖已验收的前置 Step，不能依赖后续 Step 才能验收。所需代码、命令、测试和 README 说明同一步落地，不用占位脚本或假成功响应凑验收。验收时重跑全部已落地检查，结果只记在第 5 节。

包命令均使用 `pnpm`；Docker / Compose 使用原生命令。

## Step 1：工具链与 SDK 最小验证

**交付：无需 PostgreSQL、HTTP 或模型 Key 即可检查的 TypeScript 仓库。**

### 实施

1. 检查当前及上级 Git 根目录，避免嵌套仓库；无现有仓库时初始化 `main`。添加 `.gitignore`、`.editorconfig`、`.gitattributes`、README 和无密钥的 `.env.example`，忽略真实环境文件、依赖、构建产物、数据库数据及备份、日志和 Agent 工作文件。许可证依据仓库所有权和发布方式确定，不默认采用开源许可证。
2. 初始化 ESM `package.json`，设置 `private`、Node.js engines 和固定的 pnpm `packageManager`。根据官方 JS/TS 文档与 peer dependencies 锁定兼容 SDK：`deepagents`、`langchain`、`@langchain/core`、`@langchain/langgraph`、`@langchain/langgraph-checkpoint-postgres` 及一个模型提供商集成包；仅直接声明实际使用或 peer 要求的依赖。
3. 配置 TypeScript `strict`、ESLint、Prettier 和 Vitest；测试代码纳入类型检查，不叠加与格式化重复的 lint 规则。
4. 使用 fake 模型、无副作用工具和测试用内存 checkpointer，做最小兼容性测试：Agent、可信运行时 context、StateBackend、工具、原生流，以及最新状态查询、会话后续输入、`null` 继续、HITL 批准／拒绝和调用级限制。验证中断、错误后的快照与继续语义，只验证锁定版本 API，不在此步实现 HTTP 或业务执行封装。
5. 加入 `typecheck`、`lint`、`format:check`、`test`；不添加尚无实际入口的服务或数据库命令。

### 验收

- [ ] `pnpm install --frozen-lockfile`、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm test` 全部通过；README 记录运行时和 SDK 版本结论。
- [ ] fake Agent 的工具、原生流、最新状态查询、会话后续输入及未完成任务继续测试确定性通过；HITL 批准／拒绝使用官方 `Command`，调用级限制的作用范围明确，无需数据库或真实模型。
- [ ] Git 根目录正确，真实密钥、数据库及生成文件不被提交，无空模块或占位命令。

SDK 用法以锁定版本的 JS/TS 类型、reference 和测试为准，不混用 Python 参数或其他版本 API。

## Step 2：HTTP 与 PostgreSQL 基础

**前置：Step 1。交付：可启动、有真实健康检查和统一迁移入口的服务。**

### 实施

1. 分开 `src/app.ts` 应用组装和 `src/server.ts` 进程入口；增加 `dev`、`build`、`start`，验证编译后 ESM 能由 Node.js 直接运行。
2. 用 Zod 一次解析环境变量，非法配置启动失败且不输出密钥。使用 Fastify/Pino、request ID、统一错误响应和请求体大小限制；跨域仅允许显式配置的来源。
3. 在 `compose.yaml` 加入固定版本的 PostgreSQL、健康检查和持久卷。创建共享 `pg.Pool`、Drizzle 和官方 saver，验证连接池复用；本步不提前创建业务表。
4. 增加 `db:migrate`，按第 2.2 节准备数据库；本步业务迁移为空，只执行 saver 初始化，不为迁移创建假表。业务迁移生成命令随 Step 3 的首张业务表加入。
5. 增加 `/health/live` 和 `/health/ready`，分别检查进程响应和真实数据库连接。SIGTERM 停止接收请求、有界等待在途请求，最后仅关闭一次共享连接池。
6. 增加 `test:integration`，使用 fake Agent 和真实 PostgreSQL saver，通过 SDK 验证状态保存与重新加载，并验证健康检查及连接池退出；README 写明数据库启动、迁移和服务命令。

### 验收

- [ ] `docker compose up -d postgres` 后可从空库执行 `pnpm db:migrate`，重复执行不破坏 checkpoint 数据，无假业务表或占位命令。
- [ ] `pnpm dev` 可启动；`pnpm build` 后 `pnpm start` 无需 TypeScript 运行器；非法配置启动失败。
- [ ] `pnpm test:integration` 无需模型 Key 即可通过 SDK 查询重新加载的 PostgreSQL checkpoint 状态，并验证数据库不可用时 ready 失败、SIGTERM 有界退出且连接池仅关闭一次。

## Step 3：可信身份与会话 API

**前置：Step 2。交付：经过认证的会话创建与查询，不开放 Agent 执行。**

### 实施

1. 落地第 2.5 节的一种生产认证方式和测试身份约束，得到可信 `tenantId`、`userId`；不自建账号或权限平台。
2. 用 Drizzle 定义会话表，加入 `db:generate` 生成业务迁移并接入已有迁移入口；保存会话 ID、租户、所属用户及必要时间字段，增加创建与查询接口，按第 2.3 节使用 thread 标识。关闭字段随 Step 4 的取消功能加入。
3. 复用现有 HTTP／数据库测试验证认证、归属及重启后的查询；README 提供认证配置和会话调用示例。

### 验收

- [ ] 可信身份可创建、查询自己的会话，重启后数据仍在；业务 schema 可通过 `pnpm db:generate` 生成迁移并由统一入口执行。
- [ ] 未认证、伪造身份、跨租户及同租户非所属用户访问均被拒绝，猜测会话或 thread ID 不能绕过校验。
- [ ] 生产不能启用开发身份；本步测试不依赖执行、SSE 或审批接口。

## Step 4：受控的持久化流式执行

**前置：Step 3。交付：围绕会话直接调用 SDK，支持流式输出、调用限制、显式继续与取消。**

### 实施

1. 用具体构建函数组装 Agent 和一个无副作用工具，传入可信 context、会话 thread 及 PostgreSQL saver；不把用户状态放入共享可变对象。
2. 在已有会话查询中通过 `getState()` 返回最新持久化内容和必要状态，结合进程内活跃调用与会话关闭标记决定允许的操作，不复制 SDK 状态或保存逐次执行记录。
3. 提供会话新输入、显式继续与取消接口；执行使用第 2.3 节的 SDK 入口。按会话维护最小活跃调用表和短时并发保护；取消功能在会话表加入 `closedAt` 及迁移。
4. 设置每次调用的模型与工具调用上限、超时和停止信号，优先使用 SDK 的调用级限制能力；缺少对应能力时只在调用边界增加必要计数，不建设配额框架。显式设置模型 `maxRetries: 0`，关闭所选集成中其他默认请求重试，不添加模型、工具或图节点的重试策略。
5. 按第 2.4 节直接返回 SSE，处理完成、中断、错误和停止后的关流；取消会话先落库关闭标记再通知停止，活跃记录在调用实际结束后移除。
6. 扩展有界退出，停止接收请求并通知在途调用停止，退出不关闭会话；持久化的未完成任务由用户显式继续，不做启动扫描、状态对账或自动重跑。
7. 复用 fake 模型和数据库测试；README 说明查询语义、调用级限额、继续可能重新执行未保存工作，以及停止当前调用与关闭会话的区别。

### 验收

- [ ] 工具执行、SSE 增量和调用结束可观察；同一会话可在没有未完成任务时提交后续输入并保留历史，不同会话互相隔离。
- [ ] 查询只读最新已保存的会话状态，不触发执行；覆盖输入尚未保存时服务中断的情况，不把旧内容当作该输入成功的证明，不自动重提。
- [ ] 重启后可显式继续 SDK 中已有的未完成任务；没有可继续任务时明确拒绝。活跃调用、待审批中断及其他未完成任务均阻止新输入；继续不传历史 checkpoint。
- [ ] 调用上限、超时、不自动重试及显式继续均有确定性测试；新的调用使用独立限额和计时，不依赖持久化计数。
- [ ] 活跃断线通知当前调用停止但不关闭会话；调用实际结束前不能再次执行。显式取消持久化关闭标记，重启后仍禁止输入、继续及审批，已保存内容仍可查询。
- [ ] 并发输入、继续与取消不会启动第二个调用；取消不被整段执行持锁阻塞，响应不把会话关闭或连接关闭误报为在途工作已停止。
- [ ] 输入、查询、继续、取消及 SSE 均通过归属测试；日志和流不泄密，不能访问宿主机或上报外部追踪。
- [ ] SIGTERM 有界退出；未关闭会话的持久化任务可在重启后查询，不自动继续或重放增量。

## Step 5：持久化人工审批

**前置：Step 4。交付：指定工具的暂停、批准／拒绝、审计和重启恢复闭环。**

### 实施

1. 在 Step 4 的无副作用工具上配置官方 `interruptOn`，将 `allowedDecisions` 限定为 `approve`、`reject`；等待审批时工具不执行。
2. 待审批内容只由 SDK checkpoint 保存，通过现有会话查询读取；不在业务表增加待审批状态或复制中断内容。
3. 提供会话审批决策接口，仅会话所属用户可操作；从 SDK 当前快照提取中断标识、工具名与必要参数摘要，不暴露完整图状态。客户端提交当前中断标识及对应决策，服务端校验后使用 `new Command({ resume: { decisions } })` 继续，后续输出复用已有 SSE。
4. 加入最小审批审计及迁移，只保存会话、中断标识、提交的决策、可信操作者和时间，以会话和中断标识的唯一约束拒绝重复或冲突提交。决策先记入审计再调用 SDK，记录只表示已接收决策，不证明 SDK 已应用或工具已执行，不建立独立审批状态机。
5. 决策与取消复用第 2.3 节的短时并发保护；校验会话未关闭、无活跃调用及中断仍有效。审计写入后进程中断且同一审批仍待处理时，返回决策结果未确认，不重发该决策；用户可查询会话或取消并创建新会话，不增加补偿流程。
6. 在现有集成测试中补充审批用例，不另建端到端框架。README 写明审批权限、等待、取消和重启操作，以及 checkpoint 的保留期和清理方式；首版采用运维清理，不引入后台清理调度。

### 验收

- [ ] 未批准前工具不执行，批准后执行，拒绝后当前工具调用不执行；再次申请必须重新审批，待审批时新输入及普通继续入口无法绕过审批。
- [ ] 跨租户、非所属用户、无效中断、重复及冲突决策被拒绝；关闭会话后不能再提交审批，最小审计可查询。
- [ ] 等待审批时无活跃调用，不触发超时，正常关流不关闭会话；审批后的 SDK 调用使用新的调用级限额和计时。
- [ ] 未收到事件也可查询待审批内容；重启后可处理尚未提交决策的审批，不依赖业务状态同步。已记录但结果未确认的决策不重复提交，不宣称跨表原子提交。
- [ ] 决策请求返回后续 SSE 并正确结束；审批与取消并发时，关闭后不接纳新的执行请求，已在途调用按协作式停止规则处理。

人工批准不保证外部副作用只发生一次；后续接入有副作用工具前，必须先明确幂等与重试规则，不为此提前建设通用框架。

## Step 6：Docker、CI 与干净环境交付

**前置：Step 5。交付：可由干净检出复现的首版；Step 1–6 全部验收后才算完成交付。**

### 实施

1. 编写固定版本的多阶段 Dockerfile，以非 root 运行，只包含必要产物；`.dockerignore` 排除环境文件、Git、数据库数据及备份等敏感或无关内容。
2. 在已有 Compose 中增加唯一 API 实例、健康检查、停止宽限期和资源限制；复用原 PostgreSQL 卷，以独立命令执行 `pnpm db:migrate`，不在 API 启动时迁移，不挂载 Docker socket 或开启 privileged。
3. CI 执行 frozen lockfile 安装、格式、lint、类型、单元和 PostgreSQL 集成测试、应用及镜像构建。复用已有命令与测试，不增加 CI 专用业务实现。
4. 从干净检出按 README 验证安装、迁移、认证、执行、审批、SSE 与故障排查。README 只说明当前行为和操作；技术取舍保留在本计划，不强制再维护重复 ADR。
5. 业务链路复用现有集成用例，通过应用组装函数注入 fake 模型，并验证编译产物；镜像只做启动、健康、持久卷和退出 smoke test，不在容器里重建整套业务测试，不将 fake 模型或测试依赖打入生产镜像。

### 验收

- [ ] 镜像可构建且非 root 运行，构建上下文与镜像不含密钥；容器健康检查和 SIGTERM 停止行为正常。
- [ ] 干净环境可按 README 启动数据库、统一迁移和 API；复用现有集成用例验证编译产物的执行、SSE 和审批，无需真实模型 Key。
- [ ] 保留 PostgreSQL 卷并重建容器后，会话、结果和待审批状态仍可查询；审批恢复逻辑复用 Step 5 的验证，不要求容器内重复全链路测试。
- [ ] CI 运行全部已有检查并通过；README 明确首版范围、单进程部署约束和不支持的能力。

## 4. 目录与文档

先使用少量文件，以下仅是随功能落地的布局，不是预建清单：

```text
backend/
├── src/
│   ├── app.ts
│   ├── server.ts
│   ├── config.ts
│   ├── db.ts
│   ├── schema.ts
│   ├── agent.ts
│   └── conversations.ts
├── migrations/
├── tests/
├── docs/repository-initialization-plan.md
├── compose.yaml
├── Dockerfile
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── .env.example
├── .gitignore
├── .dockerignore
├── .github/workflows/ci.yml
└── README.md
```

文件名不是强制边界；审批可先放在执行逻辑附近，配置、日志不单独建设框架。文件过大或职责不清时再拆分，不预建 `shared`、`policies`、多层 `infrastructure` 等目录。

文档只保留当前有效规则，不保留旧方案来源、变更过程或映射说明。计划管范围与验收，README 管运行方法，测试与 CI 管详细验证输出，不重复维护同一信息。

## 5. 验收记录

不另设与 Step 重复的里程碑。每完成一步，在下表记录关键命令及结论或 CI 链接，重跑此前已落地检查；未通过不标记完成。

| Step                         | 状态   | 验证记录                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1：工具链与 SDK 最小验证     | 已完成 | Node.js 24.16.0 / pnpm 11.7.0；`pnpm install --frozen-lockfile`、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm test` 全部通过，10 个 SDK 测试；`pnpm peers check` 无冲突。Git 根为 backend，main 分支；敏感及生成文件忽略规则已验证。版本与 API 结论见 README：快照使用有类型的 `agent.graph.getState()`；原生 runLimit 错误后不重置，调用局部计数探针验证新调用预算，不提前实现业务执行。 |
| 2：HTTP 与 PostgreSQL 基础   | 待执行 | —                                                                                                                                                                                                                                                                                                                                                                                                      |
| 3：可信身份与会话 API        | 待执行 | —                                                                                                                                                                                                                                                                                                                                                                                                      |
| 4：受控的持久化流式执行      | 待执行 | —                                                                                                                                                                                                                                                                                                                                                                                                      |
| 5：持久化人工审批            | 待执行 | —                                                                                                                                                                                                                                                                                                                                                                                                      |
| 6：Docker、CI 与干净环境交付 | 待执行 | —                                                                                                                                                                                                                                                                                                                                                                                                      |

## 6. 官方参考资料

执行时核对锁定版本的官方 JS/TS 文档和 API，不以文档示例替代本项目测试：

- [Deep Agents overview](https://docs.langchain.com/oss/javascript/deepagents/overview)
- [Going to production](https://docs.langchain.com/oss/javascript/deepagents/going-to-production)
- [Backends](https://docs.langchain.com/oss/javascript/deepagents/backends)
- [Fault tolerance](https://docs.langchain.com/oss/javascript/deepagents/fault-tolerance)
- [Chat models：连接韧性与默认重试](https://docs.langchain.com/oss/javascript/langchain/models#connection-resilience)
- [Human-in-the-loop](https://docs.langchain.com/oss/javascript/deepagents/human-in-the-loop)
- [LangGraph checkpointers：状态查询与执行入口](https://docs.langchain.com/oss/javascript/langgraph/checkpointers)
- [LangGraph interrupts：中断与 Command 恢复](https://docs.langchain.com/oss/javascript/langgraph/interrupts)
- [LangGraph production persistence](https://docs.langchain.com/oss/javascript/langgraph/add-memory#use-in-production)
- [PostgresSaver：使用已有连接池](https://github.com/langchain-ai/langgraphjs/blob/main/libs/checkpoint-postgres/README.md#usage-with-existing-connection-pool)
- [Drizzle PostgreSQL](https://orm.drizzle.team/docs/get-started-postgresql)
- [Unit testing](https://docs.langchain.com/oss/javascript/langchain/test/unit-testing)
