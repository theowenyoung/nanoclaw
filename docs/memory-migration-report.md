# 记忆迁移报告（Phase 2）

生成时间见文件 mtime。原始文件全部保留在各 group 的 `.memory-migration-staging/` 下，未删除。

## 逐 group 结果

| Group | 来源 | 去向 |
|---|---|---|
| telegram_main | CLAUDE.local.md | `instructions.prepend.md`（人格、沟通、Telegram 格式、管理上下文、Task Scripts）+ `memory/index.md` Core Memory |
| telegram_main | CLAUDE.md | 生成物样板（含 `Composed at spawn` 标记），丢弃 |
| telegram_calendar-only | CLAUDE.local.md | `instructions.prepend.md` + `memory/tools/google-calendar.md` |
| telegram_calendar-only | CLAUDE.md | 生成物样板，丢弃 |
| telegram_moltbook | CLAUDE.local.md | `instructions.prepend.md` + `memory/moltbook/{account,api}.md` |
| telegram_deno-deploy | CLAUDE.local.md | `instructions.prepend.md` + `memory/deploy/deno-deploy-cli.md` |
| telegram_date | CLAUDE.local.md | `instructions.prepend.md` + `memory/blog.md` |
| telegram_date | memory/owen.md（原有） | 原地保留，仅补 YAML frontmatter（`type: person-profile`），正文一字未改 |
| telegram_date | auto-memory/feedback_include_links.md | `memory/feedback-include-links.md`（原有 frontmatter 保留） |
| telegram_date | auto-memory/MEMORY.md | 拆解：时区/日记路径/博客 API → Core Memory 与 `memory/blog.md` |
| telegram_date | auto-memory 第二份副本 | 与第一份**逐字节相同**，去重丢弃 |
| telegram_show-hn | CLAUDE.local.md | `instructions.prepend.md` + `memory/index.md` Core Memory |
| telegram_show-hn | auto-memory ×2 | 两个目录均为**空**，无内容可迁移 |
| telegram_me-bot | CLAUDE.local.md | `instructions.prepend.md`（每日访谈系统完整保留）+ `memory/index.md` |
| （孤儿）global | CLAUDE.local.md | 见下「孤儿目录」 |
| （孤儿）main | CLAUDE.local.md | 见下「孤儿目录」 |

## 有意略去的内容（v1 专属，在 v2 中已失效）

- `/workspace/ipc/`、`available_groups.json`、`refresh_groups` —— v1 的 IPC 机制，v2 无此通道
- `registered_groups` 表、`register_group` MCP 工具、`isMain`/`requiresTrigger` —— v2 改用 `ncl` + wirings/engage_mode
- `store/messages.db`、`/workspace/project` 只读挂载表 —— v2 为双库会话模型
- `~/.config/nanoclaw/sender-allowlist.json` —— v2 改用 `unknown_sender_policy` + `agent_group_members`
- `/app/src/` 自改源码流程 —— v2 架构不同，改用 self-mod MCP 工具
- Agent Teams 的 `send_message({sender: ...})` —— v2 无 `sender` 参数，改为具名子 agent destination
- `target_group_jid` 跨群组调度 —— v2 用 `ncl tasks` + destinations
- Moltbook「My Current Status」（karma 0、粉丝 2、未读 4）—— 时效性计数，非持久事实
- auto-memory 里的 `currentDate: 2026-04-03` 与 v1 相对路径链接 —— 过期产物

## 孤儿目录结论

`groups/global` 与 `groups/main` 在 v2 中没有对应的 agent group（v2 的 group 目录是 `telegram_*` / `weixin_main`）。

- **`groups/main`** 是 v1 主群组指令，内容上是 `global` 的**超集**再加 v1 管理章节，且是最新的一份（唯一提到 OneCLI）。其中仍然适用的部分（Telegram 格式、Task Scripts 脚本化调度指南）**已并入 `telegram_main/instructions.prepend.md`**；管理章节因机制已被 `ncl` 取代而略去。
- **`groups/global`** 是 v1 的全局指令，除去已失效的 `/app/src` 自改章节外，是 `groups/main` 的严格子集，**没有独有的可迁移内容**。

建议：两个目录归档到 `docs/v1-fork-reference/`，不映射到任何 group。

## 未决项

- `telegram_date` 的 instructions 提到「定时问候」，但 v2 中该 group **没有任何定时任务**（迁移过来的 2 个任务分属 me-bot 与 show-hn）。如需恢复，要新建 task。
- `telegram_deno-deploy` 的凭证注入方式待定，见迁移主报告。
