# 2026-10-01 · R4 收尾提交前复验

用户明确授权提交远程仓库，目标为现有 `origin/main`，父基线 `596f1bd`。本次交付 R4 完成验证探针、脚本异常收尾回归、分层匿名证据和阶段文档；没有改变产品 `src`、依赖版本或验收范围。阶段实测仍见 [COMPLETION-EVIDENCE](COMPLETION-EVIDENCE.md)，本次新鲜复验与当前构建 Hash 见 [匿名报告](completion-delivery-2026-10-01-report.json)。

- `npm.cmd test`：120 项，119 通过、1 Windows Git 执行位条件跳过、0 失败。
- `npm.cmd run check`、`npm.cmd run build`、`npm.cmd run test:web` 通过。
- `node scripts/r4/browser-smoke.mjs`：当前构建在 Chromium 390×844 实际执行工作树和两种历史输入的准备、结果、位置、刷新及历史删除；固定 OCR/原 DSH CLI 真实运行，模型为本地 mock，没有点击生产模型开始按钮。
- `npm.cmd pack --dry-run --json --ignore-scripts`：43 个文件，含关联修复及客户端模块，无私有配置；没有安装或发布。
- 新鲜源码 Hash 与阶段记录一致；重新构建只有 `lib/client.js` 字节 Hash 不同，当前构建另经 Web/浏览器验证。历史阶段报告保留当时的源码、构建和未提交状态；不将新 Hash 写成旧实测运行时 Hash，稳定构建字节仍为发行检查缺项。

本次提交复验真实模型请求、用户源码传输及实际沙箱分配均为 0。此前 R4 的 8 次真实模型请求和两次实际沙箱是历史阶段证据，未重跑，也未动用剩余额度。R4 最小退出条件和可进入 R5 的限定范围不变；完整产品验收、更多补丁类型、干净安装、其他平台及 v1 未完成。

匿名报告记录提交前的状态。暂存后核对范围、diff、凭证模式，提交后用 `git log -1`、`git status --short --branch` 和 `git ls-remote origin refs/heads/main` 确认实际远程交付；无需通过再次提交去改写历史报告字段。
