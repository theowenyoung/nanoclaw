# NanoClaw v1 → v2 迁移记录（2026-08-31）

v1 来源：`/home/green/nanoclaw`（v1.2.47，未被本次迁移改动）
执行方式：`bash migrate-v2.sh` 完成确定性部分，`/migrate-from-v1` 完成需要判断的部分。

## 结果

10 个 agent group、10 个 messaging group、10 条 wiring 全部迁入；Telegram 收发正常；owner 已授予；
7 个群组的 v1 人格与流程已蒸馏进 v2 的 `instructions.prepend.md` + `memory/`。

## 脚本阶段遗留的问题与修复

| 问题 | 根因 | 修复 |
|---|---|---|
| Telegram 不工作 | `2c-install-telegram` 失败：适配器**代码**从未安装（凭证在 `.env`，但 `src/channels/telegram.ts` 与依赖缺失） | 按 `/add-telegram` 的 Apply 步骤补装：从 `channels` 分支复制 7 个文件、注册 barrel、`@chat-adapter/telegram@4.29.0`、build、测试 6/6 通过 |
| 机器人回 401 | OneCLI vault 里**一条 secret 都没有**；`migrate-v2.sh` 检测到 `.env` 凭证却未写入 | 将 `CLAUDE_CODE_OAUTH_TOKEN` 存为 generic secret（`api.anthropic.com` + `Authorization: Bearer {value}`） |
| 修好 secret 后仍 401 | 容器在 07:00:41 启动，早于任何 secret 存在，因此没拿到凭证 stub，且该容器一直在跑 | 重启容器，重新执行网关配置 |
| deno-deploy 群组失效 | `container.json` 用的是 v1 的 `envFromHost`，v2 无此字段、也无任何 group 级环境变量机制 | 改用工作区凭证文件；并发现基础镜像**不含 deno**，将 `deno@2.9.5` 加为该群组专属 npm 依赖并重建专属镜像 |
| 技能更新传不进容器 | migrate 把容器技能**实体复制**进每个会话的 `.claude-shared/skills/`，遮蔽了 `/app/skills` 只读挂载的实时源 | 删除 9 个群组共 37 个遮蔽副本，恢复为符号链接 |

### 已知的上游缺陷

`setup/auth.ts --create` 用 `--type anthropic` 存储凭证（x-api-key 形态），而 OneCLI 网关**只重写 `Authorization`、不重写 `x-api-key`**。
因此订阅版 OAuth token（`sk-ant-oat…`）走这条路必然失败。本安装改用 generic + `Authorization: Bearer {value}`。

## 记忆迁移

详见 `logs/setup-migration/memory-migration-report.md`（本文件同目录留存）。要点：

- `CLAUDE.local.md` 在 v2 中**没有任何代码读取**；v2 只读 `instructions.prepend.md`（合成为 `CLAUDE.md` 的 `# Persona` 段）。
  迁移前这 9 个群组的 v1 人格实际上是失效状态。
- 7 个群组已蒸馏；无符号链接、无需隔离；两份 `CLAUDE.md` 为 `Composed at spawn` 生成物，已丢弃。
- `groups/global`、`groups/main` 在 v2 无对应 agent group，已归档至 `docs/v1-fork-reference/`。

## fork 定制处理

v1 领先 upstream 60 个提交。可移植的容器技能（5 个）migrate 已搬入并修好链接。
`.claude/skills` 下 16 个 v1 独有技能**全部**改写 v1 源码或依赖 v1 架构，不可移植，
连同 4 份 v1 独有文档一并归档至 `docs/v1-fork-reference/`，附有逐项的 v2 对应做法说明。

## 运行期事件

- 08:08 左右，基础镜像 `nanoclaw-agent-v2-103408f7:latest` 被本会话之外的因素删除，
  导致所有群组 `image-unavailable`。已重建。**这台机器上可能存在会删镜像的清理任务，值得留意。**
- 重建时按操作者要求开启了 `INSTALL_CJK_FONTS=true`（已装 30 个 CJK 字体），
  截图/PDF/网页抓取中的中文不再显示为方块。

## 待办

- OneCLI 里那条无效的 anthropic-type secret `b533199e-6644-4935-a0c7-1ef13eac102c` 未能删除
  （被权限策略拦截），它是惰性的，建议在 `http://127.0.0.1:10254` 手动删除。
  同理还有两条为排查 deno 而建、最终未采用的 secret（`api.deno.com` / `console.deno.com`）。
- `telegram_date` 的指令提到「定时问候」，但 v2 中该群组没有任何定时任务（v1 迁移过来的 2 个任务分属
  me-bot 与 show-hn）。如需恢复，要新建 task。
- `loginctl enable-linger` 在安装服务时失败，SSH 登出后服务可能停止。
