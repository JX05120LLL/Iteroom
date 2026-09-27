# R0 · 官方 CLI 启动与模拟模型循环

2026-09-27；R0 Gate A 第二个切片，Gate A/B/C 均未完成。它补充[离线契约检查](DSH-CONTRACT.md)，不改变现有产品运行入口。

## 实际结果

环境为 Windows、Node.js v24.14.0、DSH 0.1.5-rc.3、Cordis 4.0.2；仓库基线 b9e3c47，已有未提交改动保留。匿名结果见 [dsh-runtime-report.json](dsh-runtime-report.json)。

| 检查 | 实际证据 | 边界 |
|---|---|---|
| 官方启动 | 通过 `dsh --profile sdk-minimal --patch ...` 启动，initialize 成功；三个独立运行进程退出码均为 0 | 这是 CLI 真启动，模型是模拟适配器；不是产品新 Host |
| 工具循环 | 2 次模拟模型调用、1 次实际合成只读工具执行；DSH 记录 tool/result，下一步请求收到相同夹具 | Loop 和调度仍由 DSH 提供，没有实现第二套 Loop |
| 拒绝读取 | 模型请求 `../outside.ts`；公开 tools.guard 拒绝，工具正文执行次数为 0，tool/result 标记错误 | 内存夹具白名单，不证明真实路径/junction 防护或产品审批流程 |
| 模型失败 | 1 次模型调用、0 次工具执行，turn/end 为 error，并保存 ITEROOM_MOCK_FAILURE | 没有改写成 completed 或验证通过 |
| 取消 | 调用公开 Agent.cancel，模型收到 AbortSignal；whenIdle 解析后记录收束，持久 turn/end 为 aborted/user | 只证明模拟模型活动收束；没有远端命令或子进程 |
| 持久化 | 4 个 Session 连续 seq；拒绝、失败和取消的终态也实际保存 | 保留 DSH JSONL，不是 Iteroom 产品任务存储 |
| 重启 | SDK 对已有 sessionId 报 already exists；另一个进程使用公开 agents.resume 恢复，历史包含既有工具结果，工具执行次数为 0 | 恢复的是已结束的合成会话；崩溃中断、未知副作用和产品任务恢复待验证 |
| 工作区 | 合成 src/greet.ts 内容和工作区条目保持不变 | 工具只读内存，不访问真实项目文件 |

拒绝读取的会话 turn/end 最终为 completed，因为模型读取拒绝结果后正常回复。这不能解释成“被拒绝的工具成功”或“测试通过”：工具错误与模型 turn 结束分别保存，模拟回答也明确未运行验证命令。

## 固定版接口发现

- 官方 Patch 新增插件要使用 `insert`；只有未知 `id` 的覆盖行不会完成注册。探针按支持格式装载独立模块，没有复制上游内部文件。
- SDK stdio 协议只有 initialize、session/prompt、shutdown。session/prompt 的 messageId 是入队回执，不是本次任务执行成功。探针只串行发送合成输入，通过对应 Session 的 turn/end 与 idle 等待本轮活动结束。
- SDK 没有单任务取消 RPC；shutdown 是整个运行时关闭。核心公开 Agent.cancel 与 whenIdle 可用于 Iteroom Host 的后续取消接口，远端执行仍须另行停止和核对。
- SDK 对已有 Session 只走 agents.create，不支持从该 prompt 接口直接恢复。核心公开 agents.resume 可加载历史；R1 Host 应显式选择新建或恢复，不能把旧 SDK 当作完整产品后端。

以上以本地固定版公开类型及实际进程结果为依据；升级后重跑契约与运行测试，不默认保持不变。

## 复验与安全边界

```powershell
node --test test/r0-dsh-contract.test.js test/r0-dsh-loop.test.js
node scripts/r0/dsh-loop-probe.mjs
npm.cmd run check
npm.cmd test
```

工具先核对固定版与原始 Profile 组合。每次新建一次性 workspace、DSH_HOME、Patch；仅继承必要系统变量，不继承 Key、代理或用户配置。Patch 禁用 9 个宿主执行提供方/工具、真实模型适配器及重试插件，工具使用 native 模式；模拟模型检查实际提供的工具只有 Iteroom 自有合成只读工具 `iteroom_read_fixture`。

探针插件通过公开工具注册、guard、模型适配、Agent 取消/恢复及生命周期接口工作。会向独立 DSH_HOME 写小型探针计数和 DSH 会话历史；计数不是产品持久化或业务工具写权限。读取内容为内存中的合成字符串，不访问用户代码或凭证，不作外部模型请求。

RPC/事件等待有超时，协议总输出上限 1 MiB，诊断上限 64 KiB；异常时先结束本次子进程，再按已核对的临时目录归属清理。报告只保留公开版本、匿名计数和检查状态，不保存原始对话、文件内容、本机路径或 Key。环境变量筛选与工具白名单不等同操作系统沙箱或网络隔离。

## 验证与下一步

本轮新增运行测试 8/8 通过；连同第一切片共 17/17。类型检查通过；现有测试 19 通过、1 项因 Windows 文件执行位能力跳过，无失败。默认 npm test 仍只运行原有测试，R0 需单独执行上面的命令。未改产品源码，不重复构建或做浏览器验收；CLI 启动与 DSH 模拟循环是本次新增的运行证据。

下一切片可推进 Gate B 的 OCR Delegate 受管 Git 输入与 JSON 契约，不调用模型。Gate A 仍缺真实模型/自有沙箱工具及相关执行恢复；Gate C 仍缺实际 OpenSandbox 的创建、执行、取消和清理。真实模型、实际沙箱、产品权限审批、崩溃恢复、浏览器和发行均不计为本轮通过。
