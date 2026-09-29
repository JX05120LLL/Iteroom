# 下一次开发提示词

```text
请继续 D:\code\Iteroom，从 docs/r3/PLAN.md、docs/r3/EVIDENCE.md 与 docs/STATUS.md 第 25 节接续。先核对 git status、HEAD/远程、服务与可用授权；保留工作区既有 R2/R3 改动，不自动 commit/push/publish。阅读 AGENTS.md、README.md、CONTEXT.md、PRD、ARCHITECTURE、ROADMAP、STATUS、ACCEPTANCE、R2/R3 证据和受管代码/测试。

当前 R0 Gate A/B/C、R1 受管只读、R2 隔离修改和 R3 用户接受/恢复仅在各自声明的 Windows/固定版/合成输入范围通过。R3 已实现现有选定 UTF-8 文件的冲突预览、接受/放弃、逐文件写回检查点、显式继续/回滚和历史删除；离线脏 Git 工作树、模拟 DSH Loop + 实际 OpenSandbox 候选接受、本地 Chromium 窄屏下载/接受/回滚/删除及注入清理失败重试均有证据。R3 最小退出条件在此范围通过，v1 未完成。旧完整 DSH Web 入口仍有宿主工具。新增/删除/重命名补丁及 A05/P0-07 未完成。

下一步按 ROADMAP 规划 R4 OCR 审查产品接线，另补 P0-07/A05 的新增、删除、重命名补丁类型。只用一次性合成仓库；不动用户源码或其他容器。R2 的真实模型 4 次授权已用完，本轮 R3 没有新授权；后续真实请求须重新说明次数、token、费用和传输范围并取得授权。真实断电、恶意并发编辑、真实用户项目和干净发行仍须单独验收，不得外推 R3 合成结果。

不要用 OCR Gate B PoC 冒充产品审查。验收按 npm.cmd run check、npm.cmd test、npm.cmd run build、npm.cmd run test:web、包清单、git diff --check 和分层的浏览器/实际沙箱证据；同步 PRD、ARCHITECTURE、ROADMAP、STATUS、README、ACCEPTANCE 和阶段证据。无本轮提交授权则留工作区待审。
```
