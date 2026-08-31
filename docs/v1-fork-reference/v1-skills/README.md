# v1 自定义 skills（仅供参考，**不要直接在 v2 运行**）

这 16 个技能是 v1 fork 独有的。它们**全部**会改写 v1 的源码或依赖 v1 架构
（`src/`、`container/agent-runner/src/`、`registered_groups`、`/workspace/ipc/`、
`store/messages.db`、`isMain` 等），而 v2 这些机制都不存在。

在 v2 里运行它们会把 v1 的假设写进 v2 源码，属于破坏性操作。保留在这里是为了
**查阅当初实现了什么**，需要时在 v2 上重新实现，而不是照搬。

| v1 技能 | 做什么 | 在 v2 里的对应做法 |
|---|---|---|
| `add-compact` | 手动上下文压缩命令 | v2 由 runner 处理压缩，`conversations/` 保留历史 |
| `add-gmail` | Gmail 集成 | OneCLI 已内置 Gmail app 连接（`onecli apps list`），走 OAuth 而非改源码 |
| `add-image-vision` | 处理 WhatsApp 图片附件 | v2 runner 原生处理附件 |
| `add-parallel` | 并行执行 | v2 有原生子 agent（`agents` MCP 工具） |
| `add-pdf-reader` | PDF 取文本 | v2 有 `/add-anydoc`（本地文档转 Markdown） |
| `add-reactions` | WhatsApp 表情回应 | 归属 v2 channel adapter，需在 adapter 层实现 |
| `add-telegram-swarm` | 每个子 agent 一个 bot 身份 | v2 用具名子 agent + destination，无需多 bot |
| `add-voice-transcription` | Whisper API 语音转写 | v2 无对应，需重新实现 |
| `use-local-whisper` | 改用本地 whisper.cpp | 同上 |
| `channel-formatting` | Markdown 转各渠道语法 | v2 有 `slack-formatting` / `whatsapp-formatting` 容器技能 |
| `claw` | 命令行跑 agent 容器 | v2 有 `ncl` + 内置 `cli` 渠道 |
| `convert-to-apple-container` | 换用 Apple Container | v2 有 container-runtime 抽象层 |
| `get-qodo-rules` | 载入 Qodo 编码规则 | 外部工具，可在 v2 上重做 |
| `qodo-pr-resolver` | Qodo PR 审查修复 | 同上 |
| `use-native-credential-proxy` | 用内置凭证代理替代 OneCLI | **不要用**：本次迁移已把凭证收敛到 OneCLI vault |
| `x-integration` | X/Twitter 发推等 | v2 无对应，需重新实现 |

原件位置：`/home/green/nanoclaw/.claude/skills/`（v1 安装未被改动）。
