# myAgents Backend

当前交付为 **Step 1：TypeScript 工具链与 Deep Agents SDK 最小验证**。尚无 HTTP 服务、数据库配置或部署入口；不需要 PostgreSQL、Docker、网络模型调用或真实模型 Key。

## 环境与检查

固定使用 Node.js **24.16.0** 和 pnpm **11.7.0**（见 `.node-version`、`package.json`）。使用你的版本管理器安装对应 Node，再安装固定的 pnpm，例如 `npm install --global pnpm@11.7.0`。

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
```

`pnpm test` 使用 Vitest、唯一的测试用 `ScriptedModel`、无外部副作用工具和 `MemorySaver`。不会加载 `.env`；测试配置关闭外部追踪。`.env.example` 不含凭证，当前无需复制。不要启用外部追踪或提交真实环境文件。

TypeScript 使用 strict / NodeNext ESM，测试代码也纳入类型检查。ESLint 仅做代码检查，Prettier 负责格式。`tsx` 已安装，但没有虚构的 `dev`、`start`、`build` 或数据库命令。pnpm 仅批准 esbuild 的安装构建脚本。

## 锁定的 SDK 版本

| 包                                         | 版本   |
| ------------------------------------------ | ------ |
| `deepagents`                               | 1.16.4 |
| `langchain`                                | 1.6.4  |
| `@langchain/core`                          | 1.3.7  |
| `@langchain/langgraph`                     | 1.7.3  |
| `@langchain/langgraph-checkpoint`          | 1.2.2  |
| `@langchain/langgraph-checkpoint-postgres` | 1.1.2  |
| `@langchain/openai`                        | 1.8.3  |
| `@langchain/langgraph-sdk`                 | 1.15.0 |
| `langsmith`                                | 0.9.0  |
| `zod`                                      | 4.6.7  |

依赖使用精确版本及 `pnpm-lock.yaml`；`pnpm peers check` 无冲突。`langsmith`、graph SDK 和 checkpoint 包为 SDK peer 依赖，并不表示启用追踪、Agent Server 或其他执行入口。PostgreSQL saver 和 OpenAI 集成按计划锁定，本阶段不连接数据库或调用提供商。

## 已验证的 JS/TS API 结论

具体用例见 `tests/sdk.test.ts`，共享 fake 模型见 `tests/helpers.ts`：

- `createDeepAgent` 可使用 fake 模型、工具、`contextSchema` 和测试内存 checkpointer；可信 `context` 从运行配置进入工具，不从模型工具参数读取。
- 默认 StateBackend 的 `write_file` 将虚拟文件保存在图状态；当前版本文本 `content` 为字符串，不使用宿主机文件系统或 Shell。
- `stream(input, { configurable: { thread_id }, context })` 支持原生 `messages` / `updates` 流；同一 thread 的后续输入保留消息，不同 thread 隔离。
- 最新快照查询不执行模型。此版本 `agent.getState()` 的声明为 `never`，运行时转发至图；测试使用有正确类型的公开入口 `agent.graph.getState(config)`，读取 `values`、`next` 和 `tasks`，不传历史 `checkpoint_id`。
- 模型错误后保留未完成任务与错误快照；重新构造 Agent 并复用 saver 后，`stream(null, config)` 可显式继续。fake 模型显式 `maxRetries: 0`，错误用例断言只有一次模型调用；恢复不代表未保存的工作绝不会重做。
- HITL 用 `interruptOn` 限定 `approve` / `reject`。中断时工具不执行，快照包含审批；普通 `null` 不能绕过审批。重新构造 Agent 后使用 `new Command({ resume: { decisions: [{ type: 'approve' /* 或 reject */ }] } })`，批准执行工具，拒绝不执行当前工具。
- **原生调用限制不等于本项目的每次调用预算**：`modelCallLimitMiddleware` / `toolCallLimitMiddleware` 的 `runLimit` 在正常结束的 `afterAgent` 中重置，错误后保存在 checkpoint 的计数仍会影响 `null` 继续。不能直接用它们实现错误恢复后的全新预算。测试还验证了官方 `wrapModelCall` / `wrapToolCall` 能以调用局部计数限制实际调用，显式继续时换用新计数，不修改 SDK 持久状态；这里只是 SDK 兼容性探针，不提供业务执行封装。

官方参考与后续实施范围见 [实施计划](docs/repository-initialization-plan.md)。本阶段测试仅证明锁定版本 SDK 的行为，不证明生产认证、取消、SSE、PostgreSQL 持久化或重启进程的交付已完成。

## 仓库与敏感文件

Git 根目录为 `backend/`，分支 `main`；不建立嵌套仓库。真实 `.env`、依赖、构建产物、数据库数据与备份、日志及 Agent 工作文件由 `.gitignore` 排除。新增工作目录也应先检查忽略规则。

仓库标记为 private。所有权与发布授权尚未确定，因此不默认授予开源许可，也不添加猜测的 LICENSE；对外发布前须由所有者确定许可证。
