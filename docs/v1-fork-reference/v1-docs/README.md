# v1 独有文档（仅供参考）

| 文件 | 说明 | v2 现状 |
|---|---|---|
| `APPLE-CONTAINER-NETWORKING.md` | Apple Container 的网络配置笔记 | v2 有 container-runtime 抽象，网络参数由 driver 处理 |
| `DEBUG_CHECKLIST.md` | v1 排障清单（多处引用 v1 路径与 IPC） | v2 用 `/debug` 技能，见 CLAUDE.md 的 Troubleshooting 表 |
| `docker-sandboxes.md` | v1 的容器沙箱设计 | v2 见 `docs/isolation-model.md`、`docs/build-and-runtime.md` |
| `skills-as-branches.md` | 技能存放于长期分支的设计 | v2 已落地为 `channels` / `providers` 分支，见 CLAUDE.md |
