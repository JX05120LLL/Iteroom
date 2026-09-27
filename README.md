# Iteroom

**本地优先的编程助手，重点构建自己的 Harness 工程能力。**

目标是让开发者通过文字理解、修改和审查代码：助手在独立环境中执行，提供补丁与真实验证证据，用户审阅后决定是否写回项目。白色方案 C 是产品视觉基线。

> 当前仍是 DSH Web 扩展开发版，已有启动器、任务审阅和 Git 净变化证据。自有 Host、OCR、OpenSandbox、冲突检测及补丁接受流程尚未完成；npm 未发布。本轮重规划不代表新架构已经运行。

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
- [接续开发提示词](docs/NEXT_SESSION_PROMPT.md)：下一会话从 R0 Gate B 开始，先核对当前工作区和证据。
- [R0 离线契约检查](docs/r0/DSH-CONTRACT.md)：DSH 公开接口、Profile/Patch 配置合成与未验证边界。
- [R0 运行检查](docs/r0/DSH-RUNTIME.md)：官方 CLI 真启动、自有合成只读工具、模拟循环、取消及会话恢复。
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

目标隔离修改模式将额外需要 OpenSandbox 服务、Docker 和任务镜像，模型请求也需要可用提供方；这些条件不会被 npm 启动器自动消除。Windows 的 Docker/WSL2 运行链路尚待验证，服务不可用时目标产品不应退回宿主执行。

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

下一步是 [R0 兼容性验证](docs/ROADMAP.md)：先验证支持的 DSH 最小启动组合、OCR Delegate JSON 与 OpenSandbox 的执行/取消/清理，再逐阶段迁移。
