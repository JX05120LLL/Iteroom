# R0 Gate A：真实模型、DSH Loop 与实际沙箱

2026-09-28，在本地 `main` 778f1f1 的未提交工作区验证。Windows / Node.js 24.14.0、Docker Linux 29.4.0、DSH 0.1.5-rc.3、Cordis 4.0.2、OpenSandbox SDK 1.1.0 / 服务源 4a5619524 与固定 digest 镜像。用户授权本轮最多 6 次 DeepSeek 请求、单次输出不超过 256 tokens、人民币费用上限 5 元；只使用合成代码。

## 实际结果

[匿名运行报告](dsh-live-report.json)记录官方 `sdk-minimal --patch` 启动和官方 `DeepSeekAdapter` 访问 `deepseek-flash` 的 **3 次真实模型请求**。DSH Loop 先调用自有内存只读工具 `iteroom_read_fixture` 1 次，再调用 `iteroom_sandbox_probe` 1 次；后者在本次 OpenSandbox 中修复合成 `add.mjs` 并执行 Node 测试，退出码为 0。工具结果返回后，模型继续一步并正常结束。报告记录请求次数、聚合用量、执行 ID/输入/输出哈希，不含 Key、请求正文、完整模型回答或私有目录。

模型报告用量为非缓存输入 866、缓存读取 640、输出 177 tokens，三次完成步骤均有 usage。请求守卫将路由、请求字段、文本消息、两个工具 schema、每次最大 128 输出 tokens（配置允许上限 256）、32 KiB 请求体及总次数固定；磁盘计数在外发前预留，失败不返还。费用预检按 2026-09-28 [官方峰时单价](https://api-docs.deepseek.com/quick_start/pricing/)（cache miss $0.30 / 1M、output $1.20 / 1M）和偏高的 2 tokens/字节、每次 8192 额外输入 tokens、20 元/美元规划系数计算：即使 6 次都达到本地请求/输出上限，规划上界约 **2.691072 元**，低于获批 5 元。它是本地保守估算，**不是服务商账户的硬限额或实际账单**；提供方价格/计费规则变化、断线后的未知计费应停止后续请求并重新核对。没有读取账单或余额，不能把用量估算写成实际扣费。

宿主合成输入哈希前后一致。重启官方 CLI 后，1 个 Session 的已有事件前缀和序号保持，模型请求数未增加，沙箱动作仍只有 1 次。两个 CLI 进程正常退出；本次沙箱、受管卷、控制服务与临时预算目录均核对清理。旧 Docker 服务和其他容器未改动。

Gate A 的取消、错误、guard 拒绝和远端父子进程停止，另有[模拟模型加实际沙箱](DSH-SANDBOX.md)与[本机 HTTP/SSE 错误/中止](MODEL-TRANSPORT.md)证据。**真实模型请求的取消、真实提供方故障及崩溃中的未知执行恢复未验证**，不能从本次正常修复推断这些路径；Gate A 仅在固定版本、合成输入和当前平台范围内通过。产品权限审批、用户项目快照/补丁接受、浏览器及发行属于后续阶段，A01–A21 未据此通过。

## 复验与边界

无需模型请求的检查：

```powershell
node --test test/r0-model-cost-bound.test.js test/r0-model-request-guard.test.js test/r0-model-budget-journal.test.js test/r0-dsh-live.test.js
npm.cmd run check
npm.cmd test
npm.cmd run build
```

真实组合复验须先重新核对当前价格、获得**新一轮**请求次数/费用授权，确认 Docker、3088 端口、受管沙箱安装和归属清理日志。以下命令会真实调用模型、创建并清理本次沙箱；不能作为默认无成本测试运行：

```powershell
$env:ITEROOM_SANDBOX_POC_ROOT = '经核对的项目外受管安装根'
$env:ITEROOM_R0_DSH_SANDBOX = '1'
$env:ITEROOM_R0_LIVE_MODEL = '1'
node scripts/r0/dsh-sandbox-probe.mjs
```

本次模型配置在 `%LOCALAPPDATA%\Iteroom\r0-model.json`，不在仓库。仅在本次获批范围内将其中 `maxCostCny` 设为 5；探针用独立临时 DSH_HOME、只继承基本系统环境，禁用默认宿主 Shell/终端和重试插件。请求守卫是应用层约束，不是操作系统网络隔离或服务商硬扣费限额。新一次运行须用新的授权和预算记录，不能沿用本次 3 次请求的批准重新获得 6 次额度。
