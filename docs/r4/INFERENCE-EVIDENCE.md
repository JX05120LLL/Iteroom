# R4-2：预算审查、覆盖与候选定位

本页与 inference 报告保留 R4-2 当时实现/Hash。最新来源关系和页面入口见 [R4-3 证据](FIX-EVIDENCE.md)，当前增量以 fix-report 为准；旧“关联修复待做”属于当时状态。

2026-10-01，在 `3d21332` 基线上保留 R3 修复和 R4-1 未提交改动，推进审查推理切片。**原 DSH CLI/Loop 与真实固定 OCR 配本地模拟模型通过；真实审查模型、关联修复、完整 R4 与 v1 未验收。**本轮外部模型请求为 0，无用户源码传输、沙箱部署、提交或推送。

实施边界见 [计划](INFERENCE-PLAN.md)，匿名结果与源码 Hash 见 [总报告](inference-report.json)、[CLI 链路](inference-loop-report.json)及[浏览器报告](inference-browser-report.json)。R4-1 的旧报告与 Hash 是历史证据，当前增量以新报告为准。

## 实现与失败处理

- 认证 carrier 提供计划预览、开始/停止、覆盖和结果 API；生产页面点击开始才发送固定代码与规则。DSH 使用原 `sdk-minimal` Loop，只开放 `iteroom_review_context(groupId)`，没有任意路径、宿主写入、Shell 或测试工具。复用既有 RPC、模型 adapter 与请求 guard，不复制 Loop、不增加依赖。
- 最多两组，每组完整编码上下文 8 KiB、总计 16 KiB；完整规则、旧/新代码和 Diff 一并计入，不静默截断。超限文件保留 pending/context_budget 或 group_budget。模型发送前持久预留最多 4 次请求、每次 512 输出 tokens，单次 HTTP 正文仍限制 32 KiB；这不是服务商账户人民币硬限额，也不是 tokenizer 精确预算。请求过大或 JSON 截断会失败，不自动扩大预算。
- 严格分组 JSON 只允许计划内路径、old/new、quote/message/severity；显式报告且实际工具返回匹配固定 Hash 的组才标已审。遗漏、未读取、异常 JSON、超限或进程失败保留失败覆盖；零发现不等于测试通过。引擎完成状态与 completed/partial/failed 审查结果分开。
- 每条发现绑定准备 Hash 和固定变更侧，宿主唯一匹配 quote 才生成行号。重复、失效片段显示未定位；去重不受 JSON 字段顺序影响，包含结尾换行的 quote 不多报一行。全部发现仍是 model_candidate，未验证为真实缺陷。
- 外部 plan/result 收据与任务 Hash 绑定，重读时重算覆盖与片段定位。缺配置不 claim；重复启动不重发；取消等待 CLI 退出。重启无完整报告的孤立运行保留 interrupted 覆盖；已收束落盘但未关联的完整报告可校验补关联，伪造行号拒绝。任务记录仍 v1，旧 R1/R2/R3/R4-1 可读；旧程序不理解新 review 状态，降级前备份外部数据。
- 删除审查记录清理其准备、计划和报告，不修改项目。DSH 引擎目录/Session 当前独立保留；全面数据清除仍是 R5 缺项。准备收束未确认的既有 cleanupPending 仍阻塞，未新增自动解除动作。

最初 4 KiB/组预算的真实 OCR 回归失败，固定默认规则正文为 3,263 字节；完整合成组编码后为 8,003 字节。将预算调整为 8 KiB/组并重新跑真实 CLI，规则未裁剪、未替换。该链路一次性合成项目共 7 项，6 已审、1 provider 排除，Host 定位 1 个模拟候选；本地模拟 adapter 两次调用，源 HEAD/index/status 不变，重启读同一收据。

## 检查结果

| 层次 | 结果 | 边界 |
|---|---|---|
| R4-2 专项 | 10/10，通过 | 零发现、预算/部分/失败、JSON、取消等待、Hash、孤立恢复、收据伪造、原 CLI 固定读取与实际进程退出；本地 mock |
| 全量 npm test | 105 项：104 通过、1 Windows 执行位条件跳过、0 失败 | 显式配置真实 OCR；包含三种输入/纳入排除回归；沙箱用既有 mock，未重跑实际沙箱 |
| 真实 OCR + 原 DSH CLI | 通过 | 一次性合成仓库，本地模型 adapter；不是 DeepSeek 真实审查质量证据 |
| Chromium 浏览器 | 通过，390×844 | 实际准备 API、覆盖/候选/固定源码、刷新/历史删除、预算待审和失败提示；推理由外部本地 mock 协调器驱动，未点击付费生产开始动作；失败 JSON 来自注入 runner |
| 历史模式 | 真实 CLI 三种执行通过 | 浏览器单提交/范围只检查表单，未执行历史审查推理 |
| check/build/test:web | 通过 | 既有 Web smoke 为认证载体、R1 与旧入口本地 stub；不替代真实审查模型 |
| npm 包 dry-run | 42 项 | 新模块与浏览器 bundle 进入包；未生成安装包、干净安装或发布 |

追加取消复测曾实际触发 Windows 元数据 rename/EPERM；Store.save 原来将一次替换拒绝直接放大为取消失败。现仅在任务锁内对同一份临时元数据的同一个原子 rename 做有限重试（Windows EPERM/EBUSY，最多 6 次、合计 375 ms 等待），不重做任务状态动作或模型调用。真实 Windows 文件锁验证首次拒绝、释放后成功；注入持续拒绝/其他错误/其他平台验证有限失败和原记录保留，两个 Store 回归加入全量。具体占用进程未确认。旁路核对：源码写回失败保留检查点，模型额度失败不发送请求，快照目录为首次创建；这些不盲目重试。旧 DSH 事件投影的 metadata rename 尚无该重试，失败仅记日志，留作后续入口治理缺项。

浏览器首次刷新验证使用文字定位器，在窄屏图标侧栏超时；改用有名称的按钮定位器后刷新恢复通过。页面汇总原来仍显示准备的待推理数，现按报告逐项显示已审/待审/失败/排除。浏览器正常/部分链路使用实际 DSH CLI 与本地模拟模型，错误状态使用注入响应；这些证据按层次分别记录。

## 复验

在项目根 PowerShell 中配置已安装的项目外工具：

```powershell
$env:ITEROOM_OCR_BIN = '<固定官方 v1.12.9 Windows x64 CLI 绝对路径>'
node --test test/managed-review-inference.test.js
node --test test/managed-review.test.js test/managed-model-guard.test.js test/managed-task-route.test.js
node scripts/r4/inference-smoke.mjs
npm.cmd test
npm.cmd run check
npm.cmd run build
npm.cmd run test:web
$env:ITEROOM_PLAYWRIGHT_CLI = '<项目外 playwright-cli.js 绝对路径>'
node scripts/r4/browser-smoke.mjs
npm.cmd pack --dry-run --json --ignore-scripts
git diff --check
```

`inference-smoke` 与 `browser-smoke` 仅建立一次性合成仓库，显式使用本地 mock adapter，不调用真实模型或沙箱；浏览器不会点击生产开始动作。真实 OCR 不可用时集成跳过/失败必须报告，不能用 mock 冒充。没有自动重新发起失败任务的动作。

## 下一步

按 R4-3 定义并实现用户选择已定位候选 → 关联 R2 修改任务 → R3 审阅 → 固定新输入复查，保留 finding/preparation/修复任务关系。不得复用旧报告当作修复后证据。真实审查模型须另获新的请求/token/费用/数据授权；R2 旧额度已用完。本轮没有启动实际沙箱，后续再按既有合成数据授权和环境核对执行。

仍缺真实模型审查质量、历史模式浏览器完整执行、真实 Host 崩溃对子进程/模型传输的专项保证、多 Host 互斥、原子输入、用户项目、新/删/重命名补丁、cleanupPending 显式解除、完整数据清除和干净发行。不能将本切片表述为完整 R4、A08–A10 或 v1 通过。
