# Iteroom

**本地优先的编程助手，重点构建自己的 Harness 工程能力。**

目标是让开发者通过文字理解、修改和审查代码：助手在独立环境中执行，提供补丁与真实验证证据，用户审阅后决定是否写回项目。白色方案 C 是产品视觉基线。

> 当前仍是 DSH Web 扩展开发版，已有启动器、任务审阅和 Git 净变化证据。R0 三个技术兼容 Gate 已在固定版本与合成输入范围内验证；自有 Host、OCR/OpenSandbox 产品接线、冲突检测及补丁接受流程尚未完成，npm 未发布。

## 职责分工

| 项目 | 在 Iteroom 中的职责 |
|---|---|
| Cordis | 组织插件、依赖和生命周期 |
| DSH 核心 | 模型推理与 Agent Loop |
| OpenCodeReview | 审查范围准备、规则参考 |
| OpenSandbox | 隔离环境中的文件操作、命令与测试执行 |
| **Iteroom 自研部分** | **任务编排、权限决策、代码快照、结果验证、用户审阅** |

目标流程：确认输入 → 隔离执行 → 检查与审查 → 导出补丁 → 冲突检查 → 用户接受或放弃。复用基础设施的同时，Iteroom 自己定义任务状态、策略、工具、证据与产品交互，不再以完整 DSH Web 产品包装作为最终架构。

v1 聚焦单用户、单项目、串行文字任务，先验证 TypeScript/Node.js 项目。语音、长期记忆、RAG 和自动策略改进不属于首版。

## 文档入口

- [产品需求](docs/PRD.md)：定位、范围、用户流程和 P0 要求。
- [目标架构](docs/ARCHITECTURE.md)：最小引擎组合、执行治理、快照与补丁流程。
- [交付路线](docs/ROADMAP.md)：R0–R5、技术 Gate 和既有代码迁移。
- [验收矩阵](docs/ACCEPTANCE.md)：真实流程、失败路径和发布门槛。
- [当前状态](docs/STATUS.md)：代码事实、可运行入口与未验证能力。
- [接续开发提示词](docs/NEXT_SESSION_PROMPT.md)：从已完成的限定范围 R0 技术验证接续，先核对工作区与阶段边界。
- [R0 离线契约检查](docs/r0/DSH-CONTRACT.md)：DSH 公开接口、Profile/Patch 配置合成与未验证边界。
- [R0 运行检查](docs/r0/DSH-RUNTIME.md)：官方 CLI 真启动、自有合成只读工具、模拟循环、取消及会话恢复。
- [R0 DSH 与实际沙箱](docs/r0/DSH-SANDBOX.md)：模拟模型经实际 Loop 调用远端工具，验证错误、取消及结束/取消会话恢复。
- [R0 真实模型组合](docs/r0/DSH-LIVE.md)：官方模型经 DSH Loop 调用自有只读/实际沙箱工具，记录请求、用量、重启和清理证据。
- [R0 模型传输准备](docs/r0/MODEL-TRANSPORT.md)及[私有计数磁盘验证](docs/r0/MODEL-JOURNAL.md)：请求约束、本机 HTTP/SSE、实际文件和独立进程的前置证据。
- [R0 OCR Delegate](docs/r0/OCR-DELEGATE.md)：固定真实 CLI、三种合成 Git 输入、JSON/覆盖/失败路径与复验。
- [R0 审查输入](docs/r0/REVIEW-INPUT.md)：旧/新侧与 diff、分叉/初始/合并提交、空输入及链接边界。
- [R0 固定副本与 Gate B](docs/r0/FIXED-REVIEW-COPY.md)：限定平台内通过；保守 Git 边界及真实 CLI 证据。
- [R0 实际沙箱](docs/r0/SANDBOX-RUNTIME.md)：Linux 容器文件/测试/取消/超时/清理。
- [R0 生命周期与网络](docs/r0/SANDBOX-FAULTS.md)：TTL、控制服务重启、清理重试与带正向对照的网络策略实测。
- [R0 Gate 汇总](docs/r0/GATES.md)：Gate A/B/C 在限定环境和合成输入范围内通过；v1 产品流程仍未完成。
- [第三方复用](docs/DEPENDENCIES.md)：来源、接口、版本及许可证要求。
- [领域术语](CONTEXT.md) · [架构决策](docs/adr/0001-own-harness-selective-reuse.md) · [协作约定](AGENTS.md)。
- [方案 C 设计基线](docs/design-options/README.md)：白色主题、Logo 和独立通话页。

## 当前开发版源码运行

需要 Node.js 22.19+ 或 24+。在本仓库安装和构建后，用合成或隔离 Git 项目试运行：

~~~powershell
npm.cmd install --registry=https://registry.npmjs.org
npm.cmd run build
npm.cmd start -- D:\code\your-project --no-open
~~~

把示例路径换成实际目录；不传路径时使用执行目录，移除 `--no-open` 可尝试打开浏览器。文字任务需在现有 DSH 页面配置模型。当前入口使用固定 `@deepseek-ai/dsh@0.1.5-rc.3` 的 Web Profile 和 `iteroom.patch.yml`，尚未收敛到目标最小组合。

当前 DSH 工具可能直接操作宿主项目，不能将此开发入口视为目标隔离模式。任务审阅只比较任务前后 Git 可见文件净变化，外部编辑可能混入；模型回答不算测试证据。数据位置、旧接口及限制见 [当前状态](docs/STATUS.md)。

目标隔离修改模式将额外需要 OpenSandbox 服务、Docker 和任务镜像，模型请求也需要可用提供方；这些条件不会被 npm 启动器自动消除。独立 R0 探针已实际验证 Windows 宿主到 Linux Docker 的基本执行链路，尚未接产品入口；服务不可用时目标产品不应退回宿主执行。

## 当前开发检查

~~~powershell
npm.cmd run check
npm.cmd test
npm.cmd run build
npm.cmd run test:web
~~~

测试命令的存在不代表本轮已经执行或 v1 验收完成。真实模型、实际沙箱、Windows/Linux 部署和公开包分别验收，不用 mock 或 UI 截图替代。

## 界面预览

[空会话](docs/screenshots/iteroom-home-desktop.png) · [语音入口](docs/screenshots/iteroom-composer-voice.png) · [桌面通话预览](docs/screenshots/iteroom-call-desktop.png) · [手机通话预览](docs/screenshots/iteroom-call-mobile.png)。

截图为已有界面资产，尚未展示目标审查/沙箱/接受补丁流程。独立通话页与麦克风、字幕、结束通话控制保持禁用，未接入语音服务。

下一步按 [路线](docs/ROADMAP.md)设计并实施 R1 自有 Host，将已验证的核心接口接入真实任务与权限流程；R0 探针不自动成为产品能力。
