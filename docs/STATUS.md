# Iteroom 当前状态

> 2026-09-26 · 本轮只重写规划与整理文档，未迁移运行时代码、安装 OCR/沙箱依赖或执行模型/沙箱任务。工作区已有未提交功能改动，已保留。

2026-09-27 更新：后续 R0 独立探针已完成官方 CLI 真启动和模拟模型/工具循环，详见第 8 节。产品仍使用原 Web 入口；真实模型、OCR 与沙箱未接入。

## 1. 代码事实

| 范围 | 源码情况 | 验证边界 |
|---|---|---|
| 本地启动 | `bin/iteroom.mjs` 启动固定 `dsh --profile web`，绑定 127.0.0.1 | 仍是全量 DSH Web，不是新自有 Host |
| 依赖 | package.json 固定 DSH 0.1.5-rc.3，配套 Cordis 包本地为 4.0.2 | 尚未收敛为最小发行组合 |
| 任务审阅 | `src/index.js` 读取 Session 事件，提供 project/tasks 只读接口 | 当前投影状态不能代表目标产品状态机已实现 |
| Git 证据 | `src/host/` 保存任务前后 Git 可见文件净变化和部分前台检查结果 | 外部编辑可能混入，不证明每行由 Agent 修改 |
| UI | 白色方案 C、双拱门 Logo、文字工作台、任务审阅与独立通话预览 | 语音控制禁用，模型配置/部分会话 UI 仍沿用 DSH |
| 测试 | 已有启动器、任务存储、工作区证据和 Web smoke 测试文件 | 本轮未重新运行，不把已有文件当作全部通过 |
| 发行 | private 开发包，已有 build/prepack 源码 | npm 未发布，完整跨平台及真实模型闭环未验收 |

## 2. 技术研究结果

- 先前 Cordis 组合检查只证明 DSH 必要插件可注册；本轮重新核对了固定版 Loop 依赖及内部工具 scheduler。生产启动、真实模型/工具、取消/恢复还需 Gate A 验证。
- OCR 已读 Delegate 源码，研究快照为 `486022d`；确认 JSON 准备接口。没有执行 OCR CLI 或真实审查。
- OpenSandbox 已读架构/SDK/执行源码，研究快照为 `4a56195`。没有部署服务、创建沙箱或验证 Windows 环境。
- 方案 C 设计与现有截图保留；设计稿里的文件、会话和字幕是示例。旧文档记录过 Windows/Node 24.14.0/Chromium UI 检查，本轮未复验。

## 3. 目标能力的当前状态

自有产品 Host/任务状态、权限策略、不可变输入快照、OCR 审查准备、沙箱执行、远端停止核对、补丁写回、冲突保护、新任务恢复及证据存储均待实施和验收。没有把文档完成视为这些功能完成。

当前 DSH 会直接通过其现有工具工作，不具备目标“仅沙箱修改”的保证。新模式未实现之前，不将当前运行版本标记为受控隔离助手。

## 4. 当前可用源码入口

需 Node.js 22.19+ 或 24+。在本仓库安装/构建后，以合成或隔离 Git 项目启动旧开发入口：

```powershell
npm.cmd install --registry=https://registry.npmjs.org
npm.cmd run build
npm.cmd start -- D:\code\your-project --no-open
```

模型配置由当前 DSH 页面承担。执行真实项目之前需要理解现有 DSH 权限和代码发送范围；当前不需要 OpenSandbox 是旧开发入口的事实，不是 v1 隔离模式无需服务。

Windows 默认数据目录为 `%LOCALAPPDATA%\Iteroom\harness`，`ITEROOM_DSH_HOME` 可隔离；启动器将产品证据置于该目录的 `iteroom` 子目录。任务开始快照可能含源码，结束时移除原始基线；异常中断可能残留。旧版本没有 UI 删除入口，清理须停止服务并备份所需历史。

现有只读接口：`GET /api/iteroom/project` 返回 `{cwd}`；`GET /api/iteroom/tasks?sessionId=...` 返回 `{tasks}`，由 DSH Connection 承载，不返回原始基线。检查状态为 passed/failed/unknown/out-of-scope；后者不算本项目验证。

## 5. 接续开发入口

阅读 [PRD](PRD.md) → [架构](ARCHITECTURE.md) → [路线](ROADMAP.md) → [验收](ACCEPTANCE.md)。下一阶段是 R0：先完成无模型的 OCR/OpenSandbox 契约实验及 DSH 最小组合验证，再接真实模型。需要真实请求时确认请求类别、次数、数据范围与费用边界。

更新本文件时写出实际命令、环境和结果位置；失败、mock 和未验证项分别记录。用户代码、配置与原有未提交改动不可为推进新架构而删除。

## 6. 本轮文档整理

旧 PRD/README 的整套 DSH 产品包装路线和 M0–M5 被新职责分工及 R0–R5 替代；新增架构、路线、验收、依赖归属、术语和架构决策。方案 C 源文件及现有截图保留，运行代码和测试未改动。

清理范围仅为废弃的 `docs/design-options/editorial/` 与 `instrument/`。删除执行被自动策略拒绝（仅返回 blocked by policy），两个目录仍在本地并继续被 Git 忽略，不进入文档索引或仓库交付。未删除 node_modules、lib、测试、当前源码或用户数据。

改写前的 README、AGENTS、.gitignore 与完整 docs 已备份到项目外临时目录，便于恢复未提交文档内容；备份没有进入仓库。

本轮检查：11 个有效 Markdown 文档、45 个本地链接与代码围栏检查通过，14 项 P0 都在验收矩阵中有明确关联；`git diff --check` 通过。未运行模型、沙箱、构建或行为测试；文档检查不代表产品验收通过。

## 7. 2026-09-27 · UI 收敛与 R0 第一个切片

- UI 确认为 DSH 布局主体，Ant Design 局部补充任务、权限、审阅、验证与设置。十页独立设计原型使用合成数据；正式产品未接入 Ant Design，运行代码未替换。
- 新增 `scripts/r0/dsh-contract.mjs` 与独立测试。核对固定版公开导出，并实际通过 CLI 的 Profile/Patch dump-config 合成候选配置；明确禁用默认宿主执行项。临时目录隔离且清理，不读取真实源码/凭证，不调用模型或沙箱。
- [结果与复验](r0/DSH-CONTRACT.md)及[匿名报告](r0/dsh-contract-report.json)：R0 测试 9/9 通过，`npm.cmd run check` 通过，原有测试 19 通过、1 项 Windows 文件执行位场景跳过。现有 `npm.cmd test` 未自动包含 R0 文件，需独立执行其测试命令。
- 应用真实启动、模拟/真实模型工具循环、权限执行、取消收束、Session 恢复、OCR 与实际 OpenSandbox 均未完成；R0 Gate A/B/C 保持未完成。未重新构建、运行浏览器或做发行验收。
- 本切片只添加独立工具并同步文档，没有切换原启动器、修改旧产品行为、安装依赖、提交或推送。

## 8. 2026-09-27 · R0 运行切片

- 新增 `scripts/r0/dsh-loop-probe.mjs`、独立合成插件及运行测试。真实启动官方 sdk-minimal CLI，禁用宿主执行项和真实模型适配器；模拟模型经 DSH Loop 实际调用自有内存只读工具并接收结果，临时合成工作区不变。
- 越界输入在工具正文之前拒绝；模型错误保留为 error。公开 Agent.cancel 收到 AbortSignal，并以 whenIdle 确认模拟活动收束。拒绝工具与正常结束的模型 turn 分别记录，不将 completed 当作验证通过。
- 四个 Session 历史与终态实际持久化。SDK 对已有 Session 报已存在；第三个 CLI 进程通过公开 agents.resume 恢复已结束会话，既有工具未重放。SDK 缺单任务取消/直接恢复，后续 Host 需显式提供这些产品动作。
- [运行结果与复验](r0/DSH-RUNTIME.md)、[匿名报告](r0/dsh-runtime-report.json)：新增运行测试 8/8，R0 合计 17/17；类型检查通过，现有测试 19 通过、1 项 Windows 文件执行位场景跳过。三个探针进程退出码均为 0。R0 测试仍单独执行，不宣称 npm test 已覆盖它们。
- Gate A/B/C 未完成。真实模型、自有沙箱工具、远端取消、权限审批、崩溃/未知副作用恢复、浏览器和发行未验证；本切片没有更换 UI/启动器、修改业务逻辑、安装依赖、提交或推送。

## 9. 2026-09-27 · 仓库阶段快照与接续

- 用户要求提交仓库；范围为当前启动器、旧开发版任务审阅/工作区证据、新定位文档及 R0 独立检查，并保留已选方案 C 资产。仅作本地阶段提交，不推送或发布。
- 提交前重新执行：`npm.cmd run check`、`npm.cmd test`、`node --test test/r0-dsh-contract.test.js test/r0-dsh-loop.test.js`、`npm.cmd run build`。分别为类型检查通过、19 通过/1 平台跳过、17/17 通过、构建通过；Web smoke、浏览器、真实模型、实际沙箱和发行本轮未复验。
- 检查时远程 main 为 b9e3c47，与提交前本地 HEAD 相同。当前仓库没有已跟踪的 GitHub Actions 工作流；本地新提交尚未推送，不能称作该提交的远程 CI 通过。
- 下一切片为 Gate B 的真实 OCR Delegate 合成 Git 输入/JSON 契约检查。可复制的[接续提示词](NEXT_SESSION_PROMPT.md)已保存；下一会话重新核对状态，不沿用过期的提交/服务判断。
