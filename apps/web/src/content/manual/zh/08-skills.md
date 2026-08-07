# Skill（技能）

Skill 是以 `SKILL.md` 为核心描述的可复用能力包。它把一段操作流程、领域知识或提示词模板封装起来，挂到 Agent 后即可被复用，是「扩展靠组合」的关键载体。

## SKILL.md 格式

每个 Skill 以一个 `SKILL.md` 为入口，开头是 YAML frontmatter：

```markdown
---
name: my-skill
description: 一句话说明这个技能做什么、何时该用（决定 Agent 何时调用它）
---

# 技能正文（Markdown）

这里写步骤、约定、示例……
```

`description` 很重要：它是 Agent 判断「要不要用这个技能」的依据，要写清楚**适用场景**。

## 创建或安装 Skill

三种方式：

- **在线创建**：进入「Skills」页面点击「新建 Skill」，在弹窗里填写名称、描述、可见范围与 `SKILL.md` 指令内容。保存后再次打开该 Skill，弹窗会出现「内容 / 文件」两个标签页，可在「文件」页添加附属文件（附属文件需先创建 Skill 才能上传）。
- **上传**：
  - 上传单个 `SKILL.md` 文件；
  - 上传 **ZIP 包**，内含 `SKILL.md` + `scripts/`、`templates/`、`references/` 等附属文件；或
  - 直接选择**整个 skill 文件夹**（浏览器读取该目录及其子目录，以最浅层 `SKILL.md` 所在目录为根落盘）。
  - 选择文件或文件夹后，在上传确认框中选择可见范围。默认是**仅自己**；只有管理员可以选择**所有用户**。
- **从 URL 安装**：打开「上传」菜单，选择「从 URL 安装」，粘贴支持的公开 URL，预览发现的 Skills，最多选择 20 个并安装到可选的 Skill 分组。

新建、上传或远程安装的 Skill 默认都是**仅自己可见**。管理员在在线创建、上传确认、远程安装或后续编辑时，可以把可见范围改为**所有用户**；普通用户可以查看并绑定这类通用 Skill，但不能修改内容、文件或远程来源。普通用户不能把自己创建的 Skill 发布给全体用户。

把已共享的 Skill 改回「仅自己」会立即停止新的跨用户绑定；其他用户的 Agent 即使仍保留旧引用，也会从下一次运行开始停止加载该 Skill。再次设为「所有用户」后，这些保留的引用才会重新生效。

支持以下远程 URL：

```text
https://skills.sh/<owner>/<repo>/<skill>
https://github.com/<owner>/<repo>
https://github.com/<owner>/<repo>/tree/<ref>/<skill-path>
```

远程安装仅支持由公开 GitHub 仓库托管的来源。a2wave 会把来源解析为完整 Git commit SHA，并安装该不可变快照；不会执行仓库里的安装脚本或包管理命令。GitHub 仓库 URL 可以发现多个 Skills，skills.sh URL 则定位到链接中指定的 Skill。

也可以使用 CLI：

```bash
a2wave skills install https://skills.sh/owner/repo/skill
a2wave skills install https://github.com/owner/repo --skill path/to/my-skill
a2wave skills install https://github.com/owner/repo --all --group team-tools
a2wave skills install https://github.com/owner/repo --all --visibility all-users
a2wave skills create --url https://skills.sh/owner/repo/skill
```

  上传成功后会直接打开该 Skill 的编辑弹窗。

典型目录结构：

```
my-skill/
├── SKILL.md          # 入口与说明
├── scripts/          # 可执行脚本
├── templates/        # 模板
└── references/       # 参考资料
```

## 管理 Skill 文件

- **追加上传**：向已有 Skill 继续上传文件。
- **重新上传（覆盖）**：用新的 `SKILL.md` / ZIP 包 / **整个文件夹**完整替换已有 Skill 的名称、描述、内容与文件（先清空旧内容再落盘）。
- **文件列表 / 读取**：查看、在线阅读 Skill 内的某个文件。
- **远程来源记录**：远程安装的 Skill 会保留仓库、路径、commit SHA 和内容摘要。编辑 Skill 或替换/追加文件后会标记为「已在本地修改」，但不会反向修改远程仓库。

## 检查并应用远程更新

远程 Skill 不会自动更新。进入 Skill 详情页并点击**检查更新**，系统会对比：

1. 最初安装的不可变 commit；
2. a2wave 当前保存的文件，包括本地修改；以及
3. 已记录分支或标签对应的最新 commit。

对话框会分别列出本地和上游新增、修改、删除的文件。互不冲突的本地与上游变更会自动合并；只有同一文件在本地和上游被改成不同内容时才会标记为冲突。遇到冲突时，可以选择：

- **保留本地版本**：冲突文件保持当前本地内容，同时应用其余上游变更；或
- **使用上游版本**：用上游内容覆盖冲突的本地文件。

只有当 revision 和内容摘要仍与检查结果一致时才会应用更新。如果检查后上游又发生变化，需要重新检查。CLI 用户可以运行：

```bash
a2wave skills check-update <skill-id-or-name>
a2wave skills update-remote <skill-id-or-name> --strategy preserve-local
```

## Skill 分组

Skill 多了用 **分组（Skill Group）** 组织。普通用户的分组只管理自己创建的 Skill；其他人共享的 Skill 需要作为单个 Skill 直接挂载。管理员可以在分组中管理任意 Skill：

1. 在「Skills」页创建分组，可在创建时直接选若干 Skill 迁入。
2. 分组支持名称、描述、图标。
3. 删除分组时，组内 Skill 的归属置空（Skill 本身不删），并自动清理 Agent 对该分组的引用。

挂载到 Agent 时，Skill 与 Skill 分组会合并去重。

管理员共享的 Skill 可能仍位于管理员自己的私有分组中；普通用户会在未分组区域看到该 Skill，并可把它作为单个 Skill 直接挂载到 Agent，但不能把它迁入自己的分组；管理员可按需在分组之间移动它。如果管理员把共享 Skill 放入普通用户的分组，分组拥有者不能移动或释放该 Skill；删除分组前需要请管理员先把它移出。如果分组中含有其他用户的私有 Skill，由于 Agent 属主不能运行全部成员，该分组不会出现在 Agent 的 Skill 选择器中；需要请管理员先把该私有 Skill 移出分组。

## 内置技能：a2wave-memory

平台内置 `a2wave-memory` 技能，当 Agent 开启 [长期记忆](/wiki/memory) 时**自动挂载**，为 Agent 提供跨会话工作日志与长期记忆的搜索能力。无需手动添加。

平台内置技能（如 `a2wave-memory`）对所有已登录用户可用，可以绑定到 Agent，并会在已登录用户克隆或导出 Agent 时保留。把认证导出包导入其他实例时，平台会复用目标实例已有的同名内置技能；其他随包导入的技能仍会创建为导入者拥有的私有副本。如果随包导入的 `a2wave-memory` 无法通过目标实例校验，其内容会保留为未挂载的私有副本，Agent 则挂载目标实例的内置技能，确保「长期记忆」开关始终有效。公开分享导出仍不会包含任何技能内容，但导入已开启长期记忆的公开分享时，会自动挂载目标实例的内置记忆 Skill；如果目标内置技能不可用，导入 Agent 的长期记忆会被关闭。

## 排错

| 症状 | 可能原因 | 解决 |
|------|---------|------|
| 上传失败 | 缺 `SKILL.md` 或 frontmatter 格式错 | 确认 ZIP 根有 `SKILL.md` 且 frontmatter 合法 |
| 远程预览没有发现 Skill | URL 路径错误、仓库不是公开仓库，或 `name` 与 Skill 目录名不一致 | 使用公开仓库，并检查 URL、`SKILL.md` frontmatter 和目录名 |
| 远程请求返回 GitHub 错误 | GitHub 暂不可用，或未认证公开 API 达到频率限制 | 稍后重试；远程安装不会降级为执行第三方安装器 |
| 远程更新报告冲突 | 同一文件在本地和上游都发生了修改 | 检查文件列表，再明确选择保留本地版本或使用上游版本 |
| 检查后远程又发生变化 | 应用更新前，已记录的分支发生了移动 | 重新执行「检查更新」并确认新的版本 |
| 看不到他人创建的 Skill | 该 Skill 仍是「仅自己」 | 由管理员确认内容适合全员后，将可见范围改为「所有用户」 |
| 已挂载的共享 Skill 不再运行 | Skill 已被改回「仅自己」 | 联系 Skill 属主或管理员确认是否需要重新共享 |
| Agent 不用某技能 | `description` 没写清适用场景 | 把「何时用」写明确 |
| 改了技能没生效 | 已挂载的 Agent 缓存 | 重新触发一次 Run |

> Skill 处于「所有用户」时，修改会影响所有仍有权引用它的 Agent。只有技能属主或管理员可以修改，共享前请先确认内容适合作为通用能力。

## 相关

- [MCP Server](/wiki/mcp-servers) · [长期记忆](/wiki/memory) · [Agent 管理](/wiki/agents)
