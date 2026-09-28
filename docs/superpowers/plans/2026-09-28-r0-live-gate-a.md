# R0 Gate A 真实模型组合验证实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变产品入口的情况下，用固定官方 DSH Loop、DeepSeekAdapter 与自有实际 OpenSandbox 工具完成一次可核对的合成修复循环，复核 R0 三个技术 Gate。

**Architecture:** 继续使用 `sdk-minimal` Profile/Patch 禁用宿主执行，受管临时 DSH_HOME 与合成 workspace。真实模型插件只注册固定只读工具和固定沙箱动作；请求守卫与项目外磁盘计数限制最多 6 次、单次 256 输出 tokens，按官方峰时价格和保守字节/汇率系数预检 5 元预算。沙箱创建、清理和会话核对复用已有 R0 探针，不另写 Loop。

**Tech Stack:** Node.js 24、DSH 0.1.5-rc.3、Cordis 4.0.2、DeepSeek 官方 `deepseek-flash`、OpenSandbox SDK 1.1.0 / Docker Linux。

**Spec:** [R0 路线](../../ROADMAP.md)、[Gate A 范围](../../r0/OPENSANDBOX-PLAN.md)、[验收](../../ACCEPTANCE.md)。

## Global Constraints

- 仅合成代码与工具 schema 可发送至 `https://api.deepseek.com`；不读取用户仓库源码或旧 DSH 凭证。
- 用户授权本轮最多 6 次模型请求、每次输出不超过 256 tokens、费用上限 5 元；未知用量、价格或预算状态停止后续请求。
- 保留现有 UI/开发入口及所有未提交改动；不提交、不推送、不进入 R1/R2。
- 报告只保存匿名计数、版本、哈希、错误码和限制；密钥、正文、原始会话、私有路径只留在项目外受管位置。

## Review Focus

- 项目外配置模型/路径/预算字段被改动：在读取密钥或联网前拒绝。
- 守卫放行非模型端点或超过预算的请求：任何外发前拒绝且计数不回退。
- 真实模型未选择工具或调用越界参数：保留真实结果，不伪报循环通过。
- DSH 子进程或沙箱清理失败：保留资源归属记录，不把未知状态标为已清理。
- 重启导致副作用工具重放：比较远端动作和持久会话前缀，不只信任模型回复。

## Tasks

### Task 1: 费用与配置边界

**Files:** `scripts/r0/model-cost-bound.mjs`, `test/r0-model-cost-bound.test.js`, 项目外 `r0-model.json`。

- [x] 写配置错误、5 元预算与过大请求上界的失败测试，运行确认红灯。
- [x] 实现固定路由/模型/请求次数/输出和峰时价格的保守预检；仅将项目外配置的 `maxCostCny` 设为获批的 5。
- [x] 运行相关测试并核对不输出密钥。

### Task 2: 真实 DSH 插件与实际沙箱组合

**Files:** `scripts/r0/fixtures/live-model-plugin.mjs`, `scripts/r0/dsh-sandbox-probe.mjs`, `scripts/r0/dsh-loop-probe.mjs`, `test/r0-dsh-live.test.js`。

- [x] 写未授权和配置/预算失败时不启动外发的测试，运行确认红灯。
- [x] 插件注册两个固定工具和官方 DeepSeekAdapter；守卫与磁盘计数覆盖进程整个生命期；探针只运行合成修复与已结束会话恢复。
- [x] 用本地模拟 HTTP/SSE 先核对 DSH 实际 wire 形状，再在获批范围内执行真实模型/真实沙箱组合。
- [x] 逐项核对工具执行、结果返回、会话持久、重启不重放、宿主输入不变和资源清理。

### Task 3: Gate 审计与交接

**Files:** `docs/r0/DSH-LIVE.md`, `docs/r0/GATES.md`, `docs/STATUS.md`, `docs/ROADMAP.md`, `docs/NEXT_SESSION_PROMPT.md` 及适用的 README/PRD/ARCHITECTURE/ACCEPTANCE。

- [x] 保存匿名实测报告，分别标注真实模型、模拟、实际沙箱和未验证项。
- [x] 运行相关 R0/产品测试、类型检查、构建、文档链接/JSON/隐私和 diff 检查。
- [x] 按 Gate A/B/C 退出条件决定 R0 是否可称完成；产品 A01–A21 不随技术 Gate 自动升级。
