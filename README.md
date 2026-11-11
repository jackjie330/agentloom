# 项目约束

除非有明确的特别指令，否则不得擅自修改 `package.json`、`tsconfig.json`、`vitest.config.ts`、`README.md` 等项目配置文件。

## 本地运行

使用 Node.js 24.16.0、pnpm 11.7.0 和 Docker Compose，以下命令均在 `backend/` 下执行。

```sh
pnpm install --frozen-lockfile
node --import tsx scripts/init-env.ts
docker compose up -d --wait postgres
pnpm db:migrate
pnpm dev
```

初始化脚本仅在缺少 `DATABASE_URL` 时生成本地凭证，保存到 `.env`（权限 `0600`）；已有凭证不覆盖。使用外部 PostgreSQL 时自行配置 `DATABASE_URL`。保留 `.env` 与数据库卷：删除或修改 `.env` 不会重置已有数据库密码。

服务默认监听 `127.0.0.1:3000`；`GET /health/live` 检查进程响应，`GET /health/ready` 检查数据库连接。服务启动不自动迁移，`pnpm db:migrate` 可重复执行。

编译后运行（先停止开发服务）：

```sh
pnpm build
pnpm start
```

停止数据库使用 `docker compose down`，不要加 `-v`，以保留数据卷。

## 检查与测试

```sh
pnpm check
pnpm test
```

`check` 依次执行 `typecheck`、`lint`、`format:check`，也可分别运行。单元及集成测试均无需真实模型 Key。

集成测试使用独立 PostgreSQL 测试库；首次创建后，替换下方密码占位符并执行：

```sh
docker compose exec postgres createdb -U myagents myagents_test
export TEST_DATABASE_URL='postgresql://myagents:<POSTGRES_PASSWORD>@127.0.0.1:5432/myagents_test'
pnpm test:integration
```

密码使用 `.env` 中的 `POSTGRES_PASSWORD`。测试不自动加载 `.env`，必须显式设置 `TEST_DATABASE_URL`，不要指向业务或生产库；测试会创建 checkpoint 表和数据。`test:integration` 自动先构建，无需预先生成 `dist/`。
