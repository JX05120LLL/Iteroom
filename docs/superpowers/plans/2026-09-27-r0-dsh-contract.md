# R0 DSH 离线契约验证 Implementation Plan

> **For agentic workers:** 使用 superpowers:executing-plans 按任务实施。当前用户已要求按已确认 PRD 逐步开发；本轮只增添独立检查工具，不更换产品入口，不提交、推送或运行付费模型。不使用子代理。

**Goal:** 提供可重复的固定版 DSH 核心契约检查及受支持 Profile/Patch 配置合成检查。

**Architecture:** 读取公开包 manifest/导出，调用公开 CLI 的 dump-config 模式；CLI 仅在一次性目录与隔离 DSH_HOME 中准备配置，不启动应用或执行 YAML 表达式。使用显式禁用项的临时覆盖配置，验证宿主工具与执行提供方都被禁用。JSON 结果只包含版本、检查状态与公开包/配置 ID。

**Tech Stack:** Node.js 24.14.0、本地 DSH 0.1.5-rc.3 / Cordis 4.0.2、node:test；解析器沿用 DSH 已安装的 js-yaml，不新增产品依赖。

**Spec:** docs/ROADMAP.md 的 R0 Gate A、docs/ARCHITECTURE.md 第 3 节、docs/ACCEPTANCE.md 的证据边界。

## Global Constraints

- 保留现有工作区全部未提交改动，现有 DSH Web 启动器不变。
- 只增加 scripts/r0、对应独立测试及 R0 记录；不启动模型或沙箱，不读取真实源码/凭证。
- 只依赖公开包导出、CLI Profile/Patch；不使用内部 scheduler。
- UI 暂定为 DSH 主体布局、白色双拱门品牌，Ant Design 局部补充，独立通话仍禁用；在 R1 实际接线时落实。
- R0 Gate A/B/C 的完整退出条件保持未完成，不把配置检查升格为运行验收。

## Review Focus

- 包版本漂移/缺失必须失败，不能默默更换版本。
- YAML 中的 !!js 必须作为未执行表达式解析；恶意表达式不能被求值。
- 新增或遗漏的宿主执行提供方/工具必须让覆盖配置检查失败。
- 重复 ID、异常 YAML 和不完整核心配置必须失败。
- 输出不能包含配置正文、Key、本机目录或真实源码；临时资源必须清理。

### Task 1：独立 R0 契约检查工具

**Files:** 创建 scripts/r0/dsh-contract.mjs、test/r0-dsh-contract.test.js。

**Interfaces:** parseConfigDump(text) 返回校验后的公开配置行；assessConfiguration(rows) 返回核心缺失项和未禁用的宿主项；inspectDshContract() 返回脱敏 JSON 证据，不返回原始配置。

- [x] 先增加失败测试：版本失配、YAML 不求值、错误结构/重复 ID、核心缺失、宿主工具遗漏、公开 CLI 的真实配置合成。
- [x] 运行 node --test test/r0-dsh-contract.test.js，确认缺少工具导致失败。
- [x] 实现工具与临时禁用覆盖项，保持异常与证据边界明确。
- [x] 同一测试转绿，再独立执行工具保存匿名结果。

### Task 2：验收记录与后续接续

**Files:** 创建 docs/r0/DSH-CONTRACT.md 与 docs/r0/dsh-contract-report.json。

- [x] 记录实际命令、版本、配置事实、失败路径与未验证项目。
- [x] 检查新增文件及 diff，不修改旧入口和产品逻辑。
- [x] 下一切片已验证候选组合真实启动、只读工具与模拟模型循环，见 2026-09-27-r0-dsh-runtime.md；OCR Delegate/实际沙箱仍待推进。真实模型请求单独说明授权范围。

## 执行记录

- 用户已确认 UI 并要求按 PRD 逐步开发，按 ROADMAP 从 R0 开始。
- 当前是带有大量既有未提交改动的共享目录；选择只新增独立工具与记录，避免创建/切换分支及覆盖主线程文件。
- 未授权 commit/push，不执行技能模板中的提交步骤。计划完成不代表 R0 完成。
- 最终自查：未知插件须复核，未知 disabled 表达式不视为核心就绪；新增测试 9/9 通过。原有测试 19 通过、1 项平台跳过；类型检查、50 个本地文档链接及 git diff --check 通过。按 verification-before-completion 以实际输出记录结果。
