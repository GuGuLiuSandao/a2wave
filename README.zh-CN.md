<div align="center">

<img src="apps/web/public/brand-icons/default.svg" alt="a2wave" width="72" height="72" />

# a2wave

**把你已经在用的 Agent CLI，变成整个团队都能调用的共享服务。**

用自然语言描述一个 Agent，绑定模型 Provider，发布到飞书、Slack、Discord、HTTP API
或定时任务。不画流程图，不写胶水代码。

[![CI](https://github.com/LilithGames/a2wave/actions/workflows/ci.yml/badge.svg)](https://github.com/LilithGames/a2wave/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022-brightgreen.svg)](https://nodejs.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

[核心概念](./docs/core-concepts.md) · [项目指南](./AGENTS.md) · [贡献指南](./CONTRIBUTING.md) · [安全策略](./SECURITY.md)

[English](./README.md) | **简体中文**

</div>

## a2wave 是什么

a2wave 把你已经在用的 Agent CLI——**Claude Code、Cursor Agent、OpenAI Codex 等**——变成整个团队都能用的、受治理的服务，可以从飞书、Slack、Discord、HTTP API 或定时任务直接触达。

你用自然语言描述一个 Agent，绑定模型 Provider，用 Skills 和 MCP Server 扩展它的能力，然后发布。剩下的交给 a2wave：凭证注入、运行排队、审计留痕、权限控制，以及投递到同事真正在用的那个渠道。

**a2wave 只做编排，不做执行。** 平台不内置 LLM 推理、不内置沙箱运行时、也没有拖拽式 DAG 编辑器——执行能力来自底层 CLI，编排用自然语言表达，而不是在流程图里连线。这些边界是刻意设计并强制约束的，详见[产品铁律](./AGENTS.md#product-identity--iron-rules)。

### 和其他方案的区别

|  | a2wave | 工作流编排（n8n、Dify、Flowise） | 裸用 Agent CLI |
|---|---|---|---|
| **逻辑怎么表达** | 自然语言 | 节点、连线、变量映射 | 自然语言 |
| **谁能用** | 整个团队，从他们本来就在用的渠道 | 谁打开编辑器谁用 | 谁有终端谁用 |
| **模型执行** | 你现有的 CLI + 你自己的凭证 | 厂商托管的运行时 | 仅本地 |
| **治理能力** | 按 Agent 的权限、审计留痕、运行排队 | 视产品而定 | 无 |

如果你的团队已经在用某个 Agent CLI，需要的是把它**共享出去**——带上权限控制、审计留痕，并投递到飞书或 Slack——而不是把它的推理过程重新画成一张图，那 a2wave 就是合适的选择。

## 核心能力

- 🤖 **自带 Agent CLI** —— Claude Code、Cursor Agent、OpenAI Codex、OpenCode、Qoder、Trae、Kimi、Pi 都可作为可互换的执行引擎。CLI 按需从锁定并校验哈希的 lockfile 安装，基础镜像因此保持精简。
- 🌊 **一次发布，多渠道触达** —— 同一个 Agent 可通过 HTTP API、飞书、Slack、Discord、A2A 协议、定时任务、GitLab / GitHub 仓库触发和平台自建聊天页触达。
- 🧩 **以组合方式扩展** —— 通过 Skills 与 MCP Server（stdio / SSE / HTTP / 代理分组）增加能力，而不是 fork 平台本身。
- 🔗 **Agent 之间互相调用** —— 基于 A2A 协议，Agent 可以调用其他 Agent，包括部署在你的实例之外的 Agent。
- 📚 **持久化记忆** —— 按 Agent 隔离的记忆，支持渐进式披露，以及关键词、向量与混合检索。
- 🧪 **内置评测** —— 用整理好的用例集回放当前 Agent 配置，并冻结 provider / 模型 / 提示词快照，保证对比公平。
- 📦 **Git 与 Perforce 工作区** —— Agent 在真实检出上工作，评测运行还会获得隔离的 worktree。
- 🔐 **企业级认证** —— OIDC 与 SAML 单点登录、按 Agent 的 owner/editor/viewer 权限、限流，以及每一次写操作背后的审计记录。

## 信任模型

a2wave 面向**企业内部团队**设计，其核心假设是：创建 Agent 的人与使用 Agent 的人，都是**善意行事、值得信任的同事**。

这一假设塑造了产品边界。Agent 运行的底层 CLI *在设计上*就拥有真实能力（文件系统访问、Shell 执行、注入的凭证）。平台刻意**不**在作者之间做沙箱隔离，也不防御精心构造恶意 Agent 的内部攻击者。平台的安全控制——认证、按 Agent 划分的权限、审计日志、限流——是为了在协作的同事之间落实**问责与最小权限**，而不是围堵已在信任边界内部的对手。

> [!IMPORTANT]
> 如果你计划把 a2wave 暴露给不可信用户，或运行不可信的 Agent 配置，这超出当前设计范围——请自行添加隔离层。完整说明见 [SECURITY.md](./SECURITY.md)。

## 快速开始（Docker）

```bash
# 1. 复制环境变量模板（开箱即用，无需修改）
cp .env.example .env

# 2. 构建并启动
docker compose up -d --build
```

服务启动后访问 **http://localhost:3502**——如果在 `.env` 里设置了 `A2WAVE_HOST_PORT`，则访问对应端口。该变量只改宿主机侧端口，容器内始终监听 3502（镜像的 `EXPOSE`、`PORT` 默认值和 `HEALTHCHECK` 都硬编码了它）。

> 如果 `ADMIN_PASSWORD` 留空，谁先打开 setup 页面谁就拿到 admin 账号——不需要任何 token。在 `.env` 中设置 `ADMIN_PASSWORD` 可在启动时初始化 admin，彻底关闭这个窗口。

> [!IMPORTANT]
> **macOS 用户**请在启动前把以下配置加入 `.env`。Docker Desktop 不共享 `/data`，且会把
> bind mount 报告为 root 所有——entrypoint 拒绝接管这种情况，不加这些配置容器会反复重启。
>
> ```bash
> A2WAVE_WORKSPACE_DIR=$HOME/a2wave-workspace
> A2WAVE_RUN_AS_UID=10001
> A2WAVE_RUN_AS_GID=10001
> ```

下一步：创建一个 Agent，绑定模型 Provider，然后发布到某个渠道。应用内的用户手册 `/wiki` 有完整的第一个 Agent 上手流程。

### 数据库后端

后端仅由 `DATABASE_URL` 决定：`postgres://` 协议表示 PostgreSQL，其他一律当作 SQLite 文件路径。

**SQLite（默认，官方支持）** —— 无需任何配置。上面的命令即可启动单容器部署，数据库位于命名卷上。

**PostgreSQL ≥ 9.6（实验性）** —— 在 `.env` 中设置连接串，并用 `postgres` profile 启动，它会带上内置的数据库容器：

```bash
# PostgreSQL 下 AUTH_SECRET 必填（见下方说明）。请生成后追加，
# 不要把命令本身当作值粘贴进去：
echo "AUTH_SECRET=$(openssl rand -hex 32)" >> .env
echo "DATABASE_URL=postgres://a2wave:a2wave@postgres:5432/a2wave" >> .env

docker compose --profile postgres up -d
```

迁移在启动时自动执行并选择对应的迁移谱系；API 会先等待数据库健康检查通过，因此冷启动是安全的。数据库端口不会发布到宿主机——在本地试用之外的场景请先修改 `POSTGRES_PASSWORD`。

确认确实跑在 PostgreSQL 上：API 启动时会打印实验性后端的警告，且表建在 PostgreSQL 里而非 `.db` 文件中：

```bash
docker compose logs a2wave | grep -i postgres
docker compose exec postgres psql -U a2wave -d a2wave -c '\dt'
```

> [!WARNING]
> PostgreSQL 目前是**实验性**的，尚不推荐用于生产：它能通过完整测试套件与端到端冒烟测试，但没有生产环境的长期运行验证。**不存在 SQLite → PostgreSQL 的数据迁移路径**——切换意味着从空数据库开始。它面向多实例部署，因为单个 SQLite 文件无法被安全共享。详细说明（含多副本时需要注意的进程内缓存问题）见 [docs/agent/postgresql.md](./docs/agent/postgresql.md)。

### 环境变量

**默认的 SQLite 部署无需填写任何变量。** `cp .env.example .env` 之后即可启动，下面每一项都有可用的默认值。唯一的例外是多副本部署，见 `AUTH_SECRET` 下方的说明。

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `AUTH_SECRET` | 自动生成 | 登录态与 token 的签名密钥。留空时，`pnpm dev` 会写入 `.env`，容器则持久化在数据卷中，因此重启不会把大家踢下线。想自己指定就显式设置（`openssl rand -hex 32`）——显式配置的密钥永远优先，且不会被覆盖。**多副本部署必填**（见下）。 |

> [!IMPORTANT]
> **多副本部署必须显式设置 `AUTH_SECRET`，且所有副本用同一个值。** 自动生成的密钥只属于生成它
> 的那个实例，副本之间会互相拒绝对方签发的 token，一方加密的 SSO 配置另一方也解不开。由于
> PostgreSQL 正是面向多实例的后端，当 `DATABASE_URL` 指向 PostgreSQL 时容器会直接拒绝启动，
> 而不是生成一个实例私有的密钥。

> **Provider API Key**（`CURSOR_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`）**不**在这里配置——请在每个 Agent 的详情页 → 环境变量中单独设置。

<details>
<summary><b>可选变量</b> —— 认证、网络与可信主机允许列表</summary>



| 变量 | 默认值 | 说明 |
|------|--------|------|
| `A2WAVE_HOST_PORT` | `3502` | Docker 部署对外发布的宿主机端口。只改**宿主机**侧，容器内始终监听 3502 |
| `ADMIN_PASSWORD` | 空 | 可选的管理员初始密码，仅在首次启动时生效且不会覆盖已有密码。**留空时，谁先打开 setup 页面谁就拿到 admin 账号——没有任何 token 保护。** 无法接受这个窗口就必须预先设置 |
| `AUTH_SESSION_TTL_DAYS` | `1` | 浏览器 cookie 与 API/CLI bearer token 的登录态有效期（天），范围 `1~365`；不配置则保持原有 24 小时行为 |
| `CORS_ORIGIN` | `http://localhost:3501` | 前端访问地址 |
| `TRUSTED_PROXY` | `false` | 仅当直连 TCP 对端在下面的允许列表中时，才信任 `X-Forwarded-For` |
| `TRUSTED_PROXY_ADDRESSES` | 空 | 逗号分隔的精确代理 IPv4/IPv6 地址或 CIDR；代理必须覆写 XFF 或逐跳追加 |
| `TRUSTED_IMPORT_HOSTS` | 空 | URL 导入 Agent 配置时，允许解析到受控企业内网地址的精确 DNS 主机名 |
| `TRUSTED_MCP_HOSTS` | 空 | 允许解析到受控企业内网地址的远程 MCP 精确 DNS 主机名 |
| `TRUSTED_A2A_ROUTE_HOSTS` | 空 | 启用仅公网模式后，仍允许解析到受控企业内网地址的远程 A2A 精确 DNS 主机名例外 |
| `SCM_WORKSPACES_ALLOWED_ROOTS` | 空 | 逗号分隔的绝对路径根目录，供非管理员自定义 Git 工作区使用；内置的 `~/.a2wave/workspaces` 始终允许 |
| `ALLOW_PRIVATE_ROUTE_TARGETS` | `true` | 默认允许普通私网/CGNAT/ULA A2A 目标，同时保留逐跳校验和 DNS 固定；设为 `false` 后仅允许公网目标（仍可配置精确域名例外） |

> 调整 `AUTH_SESSION_TTL_DAYS` 只影响新登录 / 新签发的 token；如需立即收紧已签发的 token，请配合登出、改密或 `tokenVersion` 撤销。

</details>

<details>
<summary><b>代码源与 Settings 覆盖</b> —— 通过环境变量初始化 Git / Perforce 检出</summary>

#### P4 代码源（全部填写后自动创建）

| 变量 | 说明 |
|------|------|
| `SCM_P4_PORT` | P4 服务器地址（Perforce 原生协议，非 HTTP）。明文：`host:1666`，SSL：`ssl:host:1666` |
| `SCM_P4_USER` | P4 用户名 |
| `SCM_P4_PASSWD` | P4 密码 |
| `SCM_P4_CLIENT` | P4 Workspace 名称 |
| `SCM_P4_DEPOT_PATH` | Depot 路径，如 `//depot/main/...` |
| `SCM_P4_LOCAL_PATH` | 本地同步目录，默认 `/app/data/p4-workspace` |
| `SCM_P4_AUTO_SYNC` | 是否自动同步，默认 `true` |

#### Git 代码源（填写 URL 后自动创建）

| 变量 | 说明 |
|------|------|
| `SCM_GIT_REPO_URL` | 仓库地址 |
| `SCM_GIT_BRANCH` | 分支，默认 `main` |
| `SCM_GIT_USERNAME` | 用户名（HTTPS 认证） |
| `SCM_GIT_PAT` | Personal Access Token |
| `SCM_GIT_LOCAL_PATH` | 本地克隆目录，默认 `/app/data/git-workspace` |
| `SCM_GIT_AUTO_SYNC` | 是否自动同步，默认 `true` |

#### Settings 覆盖（可选）

| 变量 | 说明 |
|------|------|
| `SETTINGS_GENERAL_WORKSPACE_PATH` | 工作区路径 |
| `SETTINGS_GENERAL_TIMEOUT_MINUTES` | 全局超时（分钟） |
| `SETTINGS_BRANDING_SUBTITLE` | 品牌副标题 |
| `SETTINGS_BRANDING_FAVICON_URL` | Favicon 地址 |

</details>

## 本地开发

### 环境要求

- Node.js >= 22（与 Docker 镜像的 `node:22-slim` 运行时保持一致）
- pnpm >= 9

```bash
pnpm install

# 创建本地 .env（AUTH_SECRET 留空即可，pnpm dev 首次启动会自动生成并写入）
cp .env.example .env

# 同时启动前端与后端（默认 API :3502 + Web :3501；
# 可在 .env 中用 PORT / WEB_PORT 覆盖）
pnpm dev

# 如果上一次运行留下了孤儿进程占用端口，用它释放
pnpm stop
```

更多开发指南、API 文档与数据库操作见 [AGENTS.md](./AGENTS.md)。

CLI 的安装、升级与发布流程见 [CLI 安装与发布](./docs/agent/cli-install-publish.md)。

## 发布渠道

一个已发布的 Agent 可以通过多个渠道触达：HTTP API、飞书、Slack、Discord、A2A 协议、定时任务、GitLab / GitHub 仓库触发，以及平台自建的聊天页。

> 飞书渠道目前支持飞书（feishu.cn）应用；Lark 国际版（larksuite.com）暂不可配置。

## 文档

| 文档 | 内容 |
|------|------|
| [核心概念](./docs/core-concepts.md) | Agent、Provider、Skill、MCP Server、代码源、Run、评测 |
| [项目指南](./AGENTS.md) | 架构、完整 API 参考、测试策略、开发约定 |
| [CLI 安装与发布](./docs/agent/cli-install-publish.md) | `a2wave` CLI 的安装、升级与发布流程 |
| [贡献指南](./CONTRIBUTING.md) | 开发环境、提交约定、质量门禁、AI 贡献政策 |
| [安全策略](./SECURITY.md) | 信任模型与漏洞披露流程 |

服务运行后还会提供交互式 API 参考（`/api/docs`，Swagger UI）与应用内用户手册（`/wiki`）。

## 用 AI 构建

a2wave 自身就是大量使用 AI 编码 Agent 构建的——对于一个 Agent 编排平台来说，这是最贴切的建设方式。每一个变更都要经过完整的测试金字塔（单元 / 集成 / E2E）、强制的 lint 与 typecheck 门禁，以及人工评审。AI 辅助的贡献也以同样的标准欢迎，详见 [AI 贡献政策](./CONTRIBUTING.md#ai-contribution-policy)。

## 参与贡献

欢迎提 issue、参与讨论与提交 PR。请先阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)——其中包含开发环境搭建、提交信息约定、变更必须通过的质量门禁，以及 AI 贡献政策。注意 a2wave 有明确的产品边界（[AGENTS.md](./AGENTS.md) 中的产品铁律），越界的特性需要先与维护者讨论。参与本项目即表示你同意遵守[行为准则](./CODE_OF_CONDUCT.md)。

> [!WARNING]
> 请**不要**通过公开 issue 或 PR 报告安全漏洞——按 [SECURITY.md](./SECURITY.md) 的流程私下披露。

## 贡献者

感谢每一位为 a2wave 做出贡献的伙伴！

<a href="https://github.com/LilithGames/a2wave/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=LilithGames/a2wave" alt="a2wave contributors" />
</a>

## 开源协议

基于 [Apache License 2.0](./LICENSE) 授权。Copyright 2026 Lilith Games——署名与随附的第三方材料见 [NOTICE](./NOTICE)。
