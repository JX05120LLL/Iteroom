# R0 DSH Loop 与自有实际沙箱工具

2026-09-27。固定 DSH 0.1.5-rc.3 / Cordis 4.0.2，官方 sdk-minimal Profile/Patch CLI、原 DSH Agent Loop 与工具接口；模型为确定性模拟适配器，OpenSandbox 为实际 SDK 1.1.0 / 固定服务 / Linux Docker。沿用已授权合成无模型范围，没有读取用户源码、调用真实模型、改产品入口/UI 或依赖。

## 本轮真实组合

[匿名报告](dsh-sandbox-report.json)与 test/r0-dsh-sandbox.test.js 验证：

- 自有工具 `iteroom_sandbox_probe` 只接受 repair/fail/wait 三个固定动作。不接收任意路径、命令、环境或 sandboxId，宿主执行插件和真实模型适配器禁用；模拟模型可见工具清单只有该工具。
- 模拟模型经原 DSH Loop 调用 repair，工具在实际沙箱修改合成 add.mjs 并执行 Node 测试；退出 0、结果输出回到模型下一步。宿主合成输入哈希不变，实际远端输出/执行 ID 仅公开哈希。
- fail 实际执行退出 7，工具结果 isError=true；模拟下一步看到错误。turn completed 只代表对话结束，不把该命令标为通过。额外越界 path 由工具 guard 在正文执行前拒绝。
- wait 实际启动远端父子进程；取消前确认两个不同正整数 PID 的 /proc 非僵尸存活。工具就绪后，插件调用公开 Agent.cancel 模拟用户取消；收到工具 AbortSignal 后显式 interrupt，再核对 running=false 和父子 /proc 已退出/僵尸、Agent.whenIdle 已完成。只接受 ENOENT 或 Z 作为停止，权限错误/无效 stat 拒绝。两个事实分开记录，未把 AbortSignal 当远端停止证据。
- 关闭并重启 DSH 官方 CLI，公开 agents.resume 恢复已结束和已取消 Session；历史事件前缀和序号保持、四会话持久化。实际远端 actions.txt 仍只有 repair/fail/wait 三行，starts.txt 仍一次，取消父子在重启后仍停止；恢复模型未调用工具。不自动重放执行。
- 一个应用沙箱，无宿主 bind/控制 key，临时服务受控环境；最终 API 404、应用/egress 容器和已记录 managed volume 消失，自己的服务停止。原 Docker 服务/其他容器保留。

当前结果为 **10/10**：5 离线边界测试、1 实际综合集成及其 4 子测试。已有 DSH 契约/内存工具循环另外复验 **17/17**，不是全部 R0 一次全量执行。npm test 仍只包括旧产品测试。

## 固定接口与失败证据

复用的是本仓库 CLI JSON-RPC 启动/事件/持久化读取辅助函数，以及上游公开工具、Agent 和 SDK；没有复制 Agent Loop、内部 scheduler 或上游执行器。

SDK 默认 adapter factory 的方法在 prototype 上，对象展开不会保留。必须显式转发 lifecycle/egress/networkPolicy/execd，原 endpoint headers 保留，仅 SSE 使用公开 factory 的 native fetch。首次实际失败发生在**分配之后**，SDK 自动删除；[失败与归属核对报告](dsh-sandbox-adapter-failure-report.json)保留 API/容器/卷消失和服务停止证据。探针在 lifecycle 返回时记录 ID 并捕获 managed volume，不能等整个 Sandbox.create 就绪才登记；SDK 自删后 404 仍须继续 Docker 核对。

创建前持久化 owner/pending，并保存已分配 ID 与捕获的 managed volumes。资源清单未知、分配未知或清理失败时保留自己的控制服务和日志，不确认清理、不清空记录再试。private config、DSH_HOME、原始 ID、合成会话和诊断仅在项目外；成功收束后删除本次 DSH 临时目录，保留安装与镜像缓存。

## 复验

先核对版本、项目外安装、Docker Linux engine、归属日志与 3088 空闲。不同时运行其他占用该端口的探针。已有无模型授权覆盖本命令，但不授权任何真实模型请求。

```powershell
$env:ITEROOM_SANDBOX_POC_ROOT = '经核对的项目外受管安装根'
$env:ITEROOM_R0_DSH_SANDBOX = '1'
node --test test/r0-dsh-sandbox.test.js
node --test test/r0-dsh-contract.test.js test/r0-dsh-loop.test.js
```

未设置执行标志时，集成明确跳过；直接运行 node scripts/r0/dsh-sandbox-probe.mjs 则未授权返回 unavailable。skip/mock 不代替真实沙箱运行。

## 未完成项

该结果证明实际 DSH 工具接线和沙箱执行治理，**未证明真实模型推理**。取消来源为探针模拟用户动作，产品取消 API、权限票据、崩溃中的未知执行恢复、用户输入快照/补丁、浏览器与发行未验。恢复只覆盖已结束/已取消且远端已核对的会话，不宣称未知副作用自动恢复。

Gate A 真实模型循环仍需授权、提供方/模型、凭证位置和请求/费用预算。请求范围见 [无模型与真实模型计划](OPENSANDBOX-PLAN.md)。Gate A、R0、v1 保持未完成，整体核对见 [GATES](GATES.md)，不提前进入 R1/R2。

后续状态：2026-09-28 已按另行授权完成[真实模型/DSH/沙箱组合](DSH-LIVE.md)，本段“仍需授权”是这份 2026-09-27 模拟模型报告当时的边界。R0 技术 Gate 已在限定范围内收口，v1 产品仍未完成。
