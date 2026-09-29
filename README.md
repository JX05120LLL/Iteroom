# Iteroom

**本地优先的编程助手，重点构建自己的 Harness 工程能力。**

目标是让开发者通过文字理解、修改和审查代码：助手在独立环境中执行，提供补丁与真实验证证据，用户审阅后决定是否写回项目。白色方案 C 是产品视觉基线。

> 当前仍是 DSH Web 扩展开发版。R0 三个技术兼容 Gate、R1 受管代码理解、R2 选定现有文件的隔离修改与 R3 用户接受/恢复，在 Windows/固定版本/合成输入范围内有分层证据。R2 使用真实 OpenSandbox、DSH Loop 和一次授权的 DeepSeek 完成小功能修改、测试及候选补丁；R3 以模拟模型/实际沙箱候选及真实浏览器验证接受、回滚与历史删除。旧 DSH Web 开发入口仍具备宿主工具能力；OCR 产品接线、更多补丁类型和 npm 发行未完成。

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
- [接续开发提示词](docs/NEXT_SESSION_PROMPT.md)：从 R3 限定证据接续，先核对工作区与剩余阶段边界。
- [R3 接受与恢复证据](docs/r3/EVIDENCE.md)：合成脏工作树、冲突、写回检查点、恢复/回滚、历史删除与缺项。
- [R2 隔离修改证据](docs/r2/EVIDENCE.md)：真实沙箱/模型、模拟模型组合、执行故障与取消、复验和缺项。
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
- [R1-1 受管任务入口](docs/r1/TASK-ENTRY.md)：版本化任务记录、请求去重、单项目串行及认证接口；任务只登记、不执行。
- [R1-2 受限文件读取](docs/r1/READ-SCOPE.md)：仅读取任务选定的本机 UTF-8 普通文件并记录内容哈希。
- [R1-3 固定输入](docs/r1/INPUT-SNAPSHOT.md)：保存选定文件的项目外副本，读时核对任务关联与哈希。
- [R1 受管只读实测](docs/r1/READONLY-LIVE.md)：独立引擎、前两轮失败、第三轮真实完成、重启与限定范围验收。
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

把示例路径换成实际目录；不传路径时使用执行目录，移除 `--no-open` 可尝试打开浏览器。独立“代码理解”面板使用本机 `DEEPSEEK_API_KEY` 或指向项目外配置的 `ITEROOM_MODEL_KEY_FILE`，不会读取 DSH Web 设置中的密钥。只有点击“固定输入并开始理解”才会发送任务选定的代码片段。当前入口仍使用固定 `@deepseek-ai/dsh@0.1.5-rc.3` 的 Web Profile 作认证页面载体；Iteroom 插件拥有受管任务/快照/权限和结果，另启最小 `sdk-minimal` 引擎。独立发行 Host 与旧开发入口替换尚未完成。

“代码理解”默认最多预留 3 次模型请求、每次最多 256 输出 tokens，可通过 `ITEROOM_MANAGED_MAX_REQUESTS`（1–4）和 `ITEROOM_MANAGED_MAX_OUTPUT_TOKENS`（1–512）调整；“隔离修改”当前每任务固定最多 4 次、每次最多 512 输出 tokens。配置无效会拒绝启动。限制按任务持久计数，不能替代服务商账单或人民币硬消费限额。DSH Web 的首次密钥提示与受管面板当前仍是两套配置流程，使用项目外 Key 时可选择“稍后配置”进入受管面板。

当前 DSH 工具可能直接操作宿主项目，不能将此开发入口视为目标隔离模式。任务审阅只比较任务前后 Git 可见文件净变化，外部编辑可能混入；模型回答不算测试证据。数据位置、旧接口及限制见 [当前状态](docs/STATUS.md)。

独立“隔离修改”面板仅对任务选定的现有 UTF-8 源文件做沙箱修改，测试文件固定；沙箱文件清单出现额外文件或链接会拒绝导出。它需要 OpenSandbox 服务、Docker Linux 后端、固定 Node 镜像以及项目外 `ITEROOM_SANDBOX_KEY_FILE`、`ITEROOM_SANDBOX_IMAGE` 配置；这些条件不会被 npm 启动器自动消除。详情见 [R2 证据](docs/r2/EVIDENCE.md)。服务不可用时受管修改失败关闭，不回退宿主执行。候选补丁可导出；用户点击接受后逐文件比较本地字节与固定输入，匹配才写回，不自动 Git add/commit。部分失败保留检查点，必须显式继续或回滚；目标再次变化时拒绝覆盖。放弃与历史删除不改项目源码。新增、删除、重命名及依赖安装还不支持，见 [R3 边界](docs/r3/EVIDENCE.md)。

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

下一步按 [路线](docs/ROADMAP.md)推进新增/删除/重命名补丁类型与 R4 审查接线，并补真实断电/并发编辑、用户项目和发行验收。旧 DSH Web 入口与宿主工具仍按原行为运行；分阶段限定证据不能外推为完整产品或 v1 验收。
