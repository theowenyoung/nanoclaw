# v1 fork 参考存档

这里存放 v1 里**没有直接映射到 v2 agent group** 的指令文件，仅作历史参考，运行时不会被读取。

## 内容

| 文件 | 来源 | 说明 |
|---|---|---|
| `v1-global-instructions.md` | v1 `groups/global/CLAUDE.md` | v1 的全局指令（对所有群组生效）。除已失效的 `/app/src` 自改章节外，是 `v1-main-instructions.md` 的严格子集，没有独有的可迁移内容。 |
| `v1-main-instructions.md` | v1 `groups/main/CLAUDE.md` | v1 主群组指令，是 global 的超集加 v1 管理章节，也是最新的一份（唯一提到 OneCLI）。其中仍适用的部分（Telegram 格式、Task Scripts 调度指南）已并入 `groups/telegram_main/instructions.prepend.md`。 |

## 为什么没有整体移植

这两份文件里的管理机制在 v2 中已全部被替换：

- `/workspace/ipc/`、`available_groups.json`、`refresh_groups` → v2 无 IPC 通道
- `registered_groups` 表、`register_group` 工具、`isMain` / `requiresTrigger` → 改用 `ncl` + wirings / engage_mode
- `store/messages.db`、`/workspace/project` 只读挂载 → v2 为双库会话模型
- `~/.config/nanoclaw/sender-allowlist.json` → 改用 `unknown_sender_policy` + `agent_group_members`
- `/app/src/` 自改源码 → 改用 self-mod MCP 工具
- Agent Teams 的 `send_message({sender})` → v2 无该参数，改为具名子 agent destination
- `target_group_jid` 跨群组调度 → 改用 `ncl tasks` + destinations

## 原件位置

v1 安装目录 `/home/green/nanoclaw/` 未被本次迁移改动，所有原始文件仍在其中。
