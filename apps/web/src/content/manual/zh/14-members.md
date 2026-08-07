# 成员管理

Agent 支持多人协作。Owner 可邀请其他用户以 **viewer** 或 **editor** 身份访问该 Agent，权限边界在后端守卫层强制，不依赖前端隐藏。典型场景：多人维护同一 Agent 而不必共享账号/API Key；按需分级（有人改 prompt、发布，有人只读 + 调试）；变更全程可审计。

## 角色与权限矩阵

| 操作 | viewer | editor | owner | admin |
|------|:---:|:---:|:---:|:---:|
| 看详情 / 配置（脱敏后） | ✅ | ✅ | ✅ | ✅ |
| 看 chat 历史 / runs | ✅ | ✅ | ✅ | ✅ |
| Chat 调试 | ✅ | ✅ | ✅ | ✅ |
| 改配置（prompt/skill/mcp/env） | ❌ | ✅ | ✅ | ✅ |
| 发布 / 停止 / 恢复 / 重置 Key | ❌ | ✅ | ✅ | ✅ |
| 克隆 / 分享 | ❌ | ✅ | ✅ | ✅ |
| 删除 Agent | ❌ | ❌ | ✅ | ✅ |
| 管理成员（增/改/删） | ❌ | ❌ | ✅ | ✅ |

> **owner** = Agent 创建者；**admin** 在所有 Agent 上等同 owner。editor/viewer 由成员表记录，同一用户在同一 Agent 上不可重复授权。

## 在 Web 管理成员

1. Agent 详情页右上角「更多操作」→ **成员管理**（仅 owner / admin 可见）。
2. 弹窗中：
   - **添加成员**：搜索用户名或邮箱（300ms 防抖）→ 选中 → 选角色 → 添加。
   - **修改角色**：在成员行下拉切换 viewer / editor，立即生效。
   - **移除成员**：点垃圾桶 → 二次确认。
3. 以 viewer/editor 登录该 Agent 时：viewer 保存/删除按钮禁用、无成员管理入口；editor 可保存/发布/克隆，但删除与成员管理仍隐藏。

## 用 CLI 管理（a2wave）

```bash
a2wave agents members list <agent>
a2wave agents members add <agent> --user alice --role editor
a2wave agents members add <agent> --user alice@example.com --role viewer
a2wave agents members update <agent> --user alice --role viewer
a2wave agents members remove <agent> --user alice
```

`--user` 支持 `usr_` ID / 用户名 / 邮箱：非 `usr_` 开头会走用户查找，命中 0 报错、命中多个会提示用 `usr_xxx` 精确指定。

## 可见性与状态码

- 打开 Agent 时响应附带 `meta.permission`，前端据此控制按钮显隐。
- `GET /api/agents` 只返回你拥有或作为成员可见的 Agent。

| 场景 | 返回 |
|------|------|
| 不可见的 Agent（非 owner/admin/成员） | **404**（不泄露存在性） |
| 可见但写权限不足 | **403** |
| 重复添加成员 | **409** |
| 添加自己 / 添加 owner / 给无主 Agent 加成员 / 用户不存在 | **400 / 404** |

## 停用离职成员（管理员）

上面的成员管理只解绑「某个 Agent」的权限。要一次性收回一个人在整个平台的访问权，用**用户管理**页（侧栏 → 用户管理，仅管理员可见）的**禁用**。

1. 在用户列表找到该账号 → 点**禁用** → 二次确认。
2. 被禁用的账号会立刻退出登录，且无法再：密码登录、SSO 登录、通过 OAuth 调用任何 Agent、以及重新获取「SSO 验证即可看」分享页的访问权。整行会置灰，状态列显示「已禁用」。
3. 需要恢复时点**启用**，权限原样回来。

> [!TIP]
> 员工离职优先用「禁用」而不是「删除」：禁用可逆，也不会让审计日志里的操作人失去指向。删除留给清理误建的账号。

> [!IMPORTANT]
> 系统始终至少保留一个可用的管理员：禁用最后一个启用状态的 admin 会被拒绝，你也不能禁用自己。

禁用不会停掉该用户名下**已发布的 Agent** —— Agent 是团队资产，不会因为创建者离职而静默下线。若要一并停服，去对应 Agent 上手动**停止**。

> [!WARNING]
> 禁用只收回**与账号绑定**的访问方式（登录、SSO、OAuth 调用、分享页）。**与账号无关**的入口不受影响：Agent API Key 属于 Agent 而非某个人，无认证发布的 Agent 同理。离职交接时请一并**重置该 Agent 的 API Key**。
>
> 另外，已经拿到分享页访客 cookie 的浏览器，在该 cookie 过期前（2 小时）仍可继续查看；禁用拦的是重新获取。

## 注意

- **克隆自动清空凭证**：editor 也能克隆，克隆体归克隆者；所有 `sensitive` env 与 Provider 凭证会被清空（`authMode` 保留以提示重填）。
- **Runs 隔离不变**：成员调试产生的 Run 仍按调用者隔离，owner 不会自动看到成员的 debug runs。
- 成员增删改记审计日志（仅管理员可在审计页查看）。
- 不支持 owner 转让、团队/组织实体、跨 Agent 权限继承。

## 相关

- [Agent 管理](/wiki/agents) · [运行记录](/wiki/runs)
