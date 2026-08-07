# Changelog

All notable changes to this project are documented in this file.

## v0.7.1

首个公开发布版本，同时上架 `a2wave` CLI（npm）与多架构容器镜像（GHCR）。

- **Agent 编排平台**：以自然语言创建、配置和编排 Agent，执行能力由底层 Agent CLI（Cursor Agent / Claude Code / Codex 等）提供，平台不介入 Agent 的运行时决策。
- **多渠道发布 Agent**：API、飞书、Slack、Discord、A2A、定时任务、站内聊天页，以及 GitLab / GitHub 仓库触发——仓库触发仅在被监听的合并请求真正发生变化时才启动运行，不做无效轮询。
- **Skills 与 MCP Server 扩展**：通过 Skill 与 MCP Server（stdio / sse / http / group）组合扩展 Agent 能力。Skill 默认创建者私有，管理员可发布为全体可见。
- **Provider 与模型发现**：Provider 绑定凭据后按凭据探测可用模型，不再维护会过期的静态模型清单。
- **Agent CLI 运行时安装**：镜像不预装任何 Agent CLI，改为按 `provider-cli-lock.json` 的固定版本与 SHA-256 校验在运行时安装，镜像体积减少 1GB 以上；安装状态始终以 `PATH` 实际探测为准。
- **评测（Evaluation）**：用 Case 集合回放 Agent 当前配置，冻结 provider / model / prompt 快照以便版本间对比；评测队列与聊天运行队列相互隔离，互不抢占并发额度。
- **知识库与工作区**：接入 Git / Perforce 代码源，Agent 运行与评测使用隔离的工作区。
- **企业能力**：账号密码与 SSO 登录、Agent 三级权限（owner / editor / viewer）、审计日志、限流、健康检查与就绪探针。
- **数据库后端**：默认 SQLite 单文件部署；PostgreSQL 为实验性支持，面向多实例部署，暂不建议用于生产，且没有 SQLite → PostgreSQL 的数据迁移路径。
- **站内使用手册**：`/wiki` 提供中文使用手册；界面支持中英文。
- **文档与 CI**：精简 README 并将配置项拆分为独立参考文档；依赖许可证清单校验不再依赖构建机环境，密钥扫描改用仓库内置规则。

> 手册无需更新（本次发布区间内无用户可感知的功能变更）。
