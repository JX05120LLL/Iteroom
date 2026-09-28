# 下一次开发提示词

以下为可复制的接续提示词。2026-09-28 的状态是阶段记录；下一会话先实时核对，不沿用服务或授权判断。

```text
请继续 D:\code\Iteroom。R0 三个技术 Gate 已在固定版本、Windows 宿主与受管合成输入范围内完成；不要把它说成 v1 产品或 A01–A21 完成。下一步从 ROADMAP 的 R1 开始，先定义自有 Host 的接口、验收和实施计划，再做一个可验证的最小切片，不提前接 R2/语音/RAG/记忆。

先读 AGENTS.md、README.md、CONTEXT.md、docs/PRD.md、ARCHITECTURE.md、ROADMAP.md、STATUS.md、ACCEPTANCE.md、DEPENDENCIES.md、docs/r0/GATES.md、DSH-LIVE.md、DSH-SANDBOX.md、OCR-DELEGATE.md、FIXED-REVIEW-COPY.md、SANDBOX-RUNTIME.md、SANDBOX-FAULTS.md，以及相关 scripts/r0、现有产品代码和测试。先核对 git status、HEAD、远程、CI 与服务状态，保留全部未提交改动。上次本地/远程 main 为 778f1f1，实际状态以新检查为准。不自动 commit/push/publish，不停止其他会话服务。

已验证的 R0 事实：
- Gate A：DSH 0.1.5-rc.3 / Cordis 4.0.2，官方 sdk-minimal Profile/Patch，禁用宿主执行，原 Loop 挂载自有内存只读与沙箱工具。2026-09-28 官方 deepseek-flash 真实请求 3 次；工具各执行 1 次，实际沙箱修复并运行 Node 测试退出 0，模型收到结果继续；重启后 Session 保留，模型请求/远端动作未增加，宿主合成输入未变。匿名报告 docs/r0/dsh-live-report.json。模拟模型+实际沙箱另验证远端失败、guard 拒绝、取消父子停止、结束/取消会话恢复；回环 HTTP/SSE 单独验证合成 401/Abort。真实提供方故障/流取消及产品未知副作用恢复未验。
- Gate B：固定 OpenCodeReview v1.12.9 Windows x64 真实 CLI。受管合成 Git 的工作树、单提交、范围、旧/新侧、测试纳入、删除/重命名、固定副本及异常边界已验；非原子捕获、非 OS 只读，不是产品 WorkspaceManager。
- Gate C：固定 OpenSandbox SDK 1.1.0 / 服务源 4a5619524 / digest 镜像，Windows→Linux Docker。真实文件/命令/测试/导出、取消父子、超时、SSE 断线、TTL、服务重启、清理重试及有限 IPv4 DNS/TCP 正反对照已验。网络结果不外推全部协议或宿主端点，沙箱服务/SDK不是产品接线。
- 用户曾授权 R0 本轮最多 6 次 DeepSeek 请求、每次输出不超过 256 tokens、费用上限 5 元；实际发出 3 次。本轮授权已用于该次验证，不自动延续为下一会话的新模型调用许可。配置在项目外 %LOCALAPPDATA%\Iteroom\r0-model.json，Key 不回显、不入仓库；本地保守费用预检不是服务商硬限额/实际账单。再次收费测试先取得新授权并核对最新官方价格。
- R0 探针不是产品 Host；当前启动器仍是完整 DSH Web 开发入口，方案 C 白色 UI、双拱门 Logo 和禁用独立通话预览保持不动。旧 Docker、其他容器/服务、项目外安装和备份保留。

R1 建议首切片：只用合成 Git 项目，定义单项目串行 Task/Execution/Session 映射、只读任务入口及状态/证据接口；先验证状态与权限边界，再逐步接快照、沙箱、补丁和审阅。根据 PRD/ACCEPTANCE 写明本切片的通过条件，不把 R0 模型/沙箱探针直接包装成产品能力。涉及数据格式、权限或入口变化时同步 PRD、架构、路线、STATUS、README 与 UI 状态。

无模型复验入口：
node --test test/r0-dsh-contract.test.js test/r0-dsh-loop.test.js test/r0-model-cost-bound.test.js test/r0-model-request-guard.test.js test/r0-model-budget-journal.test.js test/r0-dsh-live.test.js
npm.cmd run check
npm.cmd test
npm.cmd run build

OCR、沙箱及真实模型的重跑条件和命令见各 R0 文档。未配置真实工具或未授权时的 skip/unavailable 不能算 Gate 重新通过。最终按实际结果分别报告离线、真实 CLI、实际沙箱、真实模型、浏览器与发行；保留所有用户改动，不自动提交或推送。
```
