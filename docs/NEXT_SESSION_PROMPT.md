# 下一次开发提示词

可将下面内容直接复制到新的开发会话。提交、远程与服务状态需要重新核对，不把本文当作实时状态。

```text
请继续开发 D:\code\Iteroom。本轮目标是按照 PRD/ROADMAP 推进 R0 Gate B：OpenCodeReview Delegate 的真实 CLI 输入与 JSON 契约验证。

先只读核对：
1. 阅读 AGENTS.md、README.md、CONTEXT.md，以及 docs/PRD.md、ARCHITECTURE.md、ROADMAP.md、STATUS.md、ACCEPTANCE.md、DEPENDENCIES.md、r0/DSH-CONTRACT.md、r0/DSH-RUNTIME.md。
2. 检查 git status、最新提交、上游/远程状态、CI 与已有服务。保留全部未提交改动，不重置、不覆盖、不停止其他会话的服务。
3. 阅读 scripts/r0、test 和相关现有实现，区分已实现、模拟验证、真实验证与规划能力。

当前基线：
- 产品入口仍为完整 DSH Web 开发版，尚未迁移为自有 Host；不要提前替换启动器或删除旧模块。
- DSH 0.1.5-rc.3、配套 Cordis 4.0.2。R0 已用官方 CLI Profile/Patch 实际启动，完成自有合成内存只读工具、模拟模型循环、guard 拒绝、错误、Agent.cancel/whenIdle 及已结束 Session 的 agents.resume 验证。
- 固定版 SDK 无单任务取消 RPC，已有 sessionId 的 prompt 会尝试 create 并拒绝；核心公开接口才是后续 Host 取消/恢复的接入点。不要复制 Loop 或依赖内部 scheduler。
- 提交前复验：R0 17/17；现有测试 19 通过、1 个 Windows executable-bit 场景跳过；类型检查与构建通过。npm test 不包含 R0，需要单独执行。Web smoke/浏览器、真实模型、OpenSandbox 与发行验收本次未复验。
- R0 Gate A/B/C 均未完成。OCR 的 486022d 与 OpenSandbox 的 4a56195 是研究快照，不能直接当作已验证发行版本。
- UI 已暂定为 DSH 主体、白底、深绿、双拱门；Ant Design 只补充任务、权限、审阅和配置。正式产品尚未安装 Ant Design。独立通话预览继续禁用，不接语音、RAG 或记忆。

本轮实施：
1. 先给出简短计划、接口和验收条件，再实际实现下一个可验证切片。
2. 核对固定版本/研究快照的官方 Delegate CLI、支持平台与实际 JSON schema。现有文档提到 preview/rule，但参数、输入模式和 schema 必须由实际版本确认，不能猜测。
3. 在一次性受管 Git 仓库中准备同一组合成数据，分别验证工作树、单提交、提交范围，覆盖新增、修改、删除、重命名及测试文件的覆盖/排除原因。不在用户项目造提交或改动。
4. 使用参数数组、明确 cwd、受控环境、时限和输出限额调用 CLI；验证 JSON 结构/版本及路径范围，拒绝越界、不可定位或不完整结果。覆盖异常 JSON、进程失败、超时、输出超限和规则失败；证据不足不显示通过。
5. 优先新增独立 R0 探针、相关测试、匿名报告和复验说明，不接完整 OCR Agent，不提前实现 R1/R2。需要下载/构建公开工具时使用隔离目录并记录来源与版本，不默认改产品依赖或全局环境；真实 CLI 不可用时明确缺项，mock 不算 Gate B 完成。
6. 运行相关测试、类型检查、必要构建、文档链接和 git diff --check；同步 PRD、架构、ROADMAP、STATUS、依赖与验收记录中的实际变化。

执行边界：本轮不调用付费/真实模型，不向远端发送用户源码，不部署 OpenSandbox/Docker，不读取凭证。不自动 commit/push/publish。宿主操作仅限必要的开发文件与一次性合成测试资源；清理前核对目录归属。

请完成本轮切片后交付结果，而不是只给计划。最后分别说明实际 CLI、离线/mock、未验证项、复验命令和下一步；不要将局部绿色结果表述为 R0 或 v1 已完成。
```
