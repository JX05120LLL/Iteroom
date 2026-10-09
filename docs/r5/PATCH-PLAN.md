# R5-3 补丁契约实施计划

沿用用户已确定的 PRD/R5 续开发范围；按 writing-plans 编写，当前会话逐项实现，不自动提交或推送。按 requesting-code-review 使用一个只读审阅代理，发现的稀疏数组、空路径和初始化清理问题均已修复。规格见 [PATCH-CONTRACT](PATCH-CONTRACT.md)，结果见 [PATCH-EVIDENCE](PATCH-EVIDENCE.md)。

目标：将四种文本补丁的路径/内容/权限/冲突/恢复语义做成可重复离线检查。Node 内置库及 node:test，无新增依赖、无第二套 Loop、无模型/沙箱或用户源码。

## 本切片

1. `test/managed-patch-contract.test.js`：先写失败用例，验证不存在与空文件、混合四种类型、路径权限、严格元数据和篡改拒绝；在一次性合成 Git 项目实际 apply/check 导出补丁，并验证文件/HEAD/index。
2. `src/host/managed-patch-contract.js`：实现纯 `definePatchScope` / `createPatchCandidate` / `validatePatchCandidate`，复用现有输入验证及 TaskEntryError。16 路径、单侧256KiB、侧总量1MiB/patch1MiB/JSON2MiB，保守拒绝碰撞/测试文件改动/权限与目录变化。
3. 先写冲突与恢复失败用例，再实现纯 `planPatchApplication` / `planPatchRecovery`。校验任务/快照/产物关联，未知步骤与外部变更拒绝；部分 rename、删除、新增、修改的 finish/rollback 及中断 rollback 逐项验证。
4. 既有 v1 Artifact/Acceptance 冷读回归；v2 注入 v1 保存路径必须拒绝，无目录污染。只将内部契约模块和新测试加入包清单/测试入口，当前 API/UI 不调用。
5. 跑专项、全量、check/build，核对打包文件及源码 Hash；记录匿名合成 Git 证据，同步 README/PRD/ARCHITECTURE/ROADMAP/STATUS/ACCEPTANCE/NEXT。本轮不自动 commit/push。

## 后续独立切片

上述五项已完成本轮限定验证：相关 29/29、全量 157 通过/1 Windows 跳过、check/build/test:web、45 项包清单和最终匿名探针。所有实现限纯契约与导出验证；下面三项尚未接线，产品未支持四种修改操作。

1. v2 安全 snapshot/artifact 持久化及 read-only 输入检查：包括不存在的父目录、安全链接拒绝、重复捕获与取消等待，无模型先验。
2. 任务的显式操作批准、沙箱工具/库存/导出及 UI 状态；现有 v1 工具保持原范围，真实沙箱单独验。
3. v2 接受的独占创建、移除、逐步日志与恢复；合成脏 Git 和冲突/故障测试通过后再做真实模型/沙箱闭环。每项分别报告未验部分，不能提前标 R5/v1 完成。
