# R4 阶段退出验证 · 2026-10-01

**ROADMAP 的 R4 最小退出条件在 Windows / 固定版本 / 一次性合成仓库 / 选定现有文本文件范围内通过，可以进入 R5。** 本轮补齐实际沙箱组合与真实审查模型证据；不是全部 A08–A10、P0 或 v1 通过，也没有提交、推送或发布。

基线为 `main` / `596f1bd`，开始时工作区干净且远程一致。原 R4 产品代码已在该提交中，本轮主要新增可复验探针和证据，并补验证脚本异常收尾回归。保留方案 C、Logo、独立禁用通话页和旧 DSH Web 入口。计划见 [COMPLETION-PLAN](COMPLETION-PLAN.md)，最终检查与当前源码 Hash 见 [总报告](completion-report.json)。历史 R4-1/2/3 报告保留原范围。

## 对照阶段退出条件

| R4 条件 | 本轮实际证据 | 范围 |
|---|---|---|
| 工作树、单提交、提交范围可用 | [合成 CLI 闭环](completion-synthetic-report.json)三种真实 OCR + 原 DSH Loop 完整执行；[浏览器](completion-modes-browser-report.json)实际准备两种历史输入、显示完成与位置、刷新及删除 | 历史模式推理为本地 mock；工作树另有真实模型 |
| 测试文件覆盖明确 | `.test.ts` 从 OCR 默认 `default_path` 显式补入；`.test.mjs` 由 Delegate 原生纳入；删除读 old，重命名保留旧路径，provider 记录排除 | 不把审查覆盖称为测试覆盖率 |
| 问题有位置和依据 | 真模型返回固定 quote，Host 唯一匹配第 1 行；模型不能提供未经核对的行号。重复/失效 quote、部分/失败/无发现仍经已有回归 | 所有模型发现仍为候选 |
| 修复闭环可演示 | [真实 UI 闭环](completion-live-browser-report-3.json)：页面准备/开始审查 → 选择发现/测试 → 开始实际沙箱修改 → 审阅并接受 → 新输入/新报告 → 刷新/重启读取 | 原 DSH、官方 DeepSeek、OCR、OpenSandbox；没有注入修改产物或本地 mock |

## 实际运行

环境为 Windows、Node 24.14.0、Docker Linux 29.4.0；DSH 0.1.5-rc.3、Cordis 4.0.2、OCR v1.12.9 / bccbc15f、OpenSandbox SDK 1.1.0 / 服务 `0.1.0.dev1+g4a5619524`。Node 镜像 digest 和控制服务前提见两份运行报告。控制服务仅回环 3088、bridge、无宿主挂载、任务网络默认拒绝。没有改既有配置、拉新依赖或把用户源码送到模型/沙箱。

无模型链路在新的合成仓库中保留 staged、unstaged、untracked 输入：三种审查输入完成；真实沙箱原测试 exit 1，模拟模型经原 DSH 自有工具修改后 exit 0；真实补丁 `git apply --check` 成功。接受前宿主 HEAD/index/status/源码/测试 Hash 不变；接受后只有选定源码改变，HEAD/index/测试不变。接受后的固定输入、报告和关系均是新的，重启读同一结果、不重放。模型外部请求为 0。

另一全新合成仓库从 **Chromium 390×844 的生产按钮**执行真实模型闭环。首次审查预留 **2** 次、修复 **4** 次、复查 **2** 次，合计 **8/12**；每次输出上限 512 tokens、请求正文上限 32 KiB。实际沙箱固定测试 exit 0，补丁可应用，用户接受前未写本地；接受/新准备/新审查均由页面显式触发。重启读取结果不增加请求，未再执行剩余 4 次，也不将额度转用于 R5。

首次模型提出 **3 个候选**，复查提出 **2 个候选**。被选择的除零问题对应源码从 `value / 0` 改为 `value / 2`，固定回归测试实际通过；旧除零候选不再出现在新侧报告。复查对函数行为命名及合成常量变化仍提出疑虑，其中行为与本次明确目标相符。它们保留为待人工判断，不能把模型严重度当作确认缺陷，也不能声称审查质量、误报率或所有问题都已解决。产品没有自动将原候选标为“已证实修复”。

两次实际沙箱串行分配，各自只传合成文件、不挂载本地项目；所属 API 查询为 404，最终 Docker 容器集合仍为原 **7** 个、卷集合仍为原 **9** 个。各自服务停止，后续本机核对没有本次 Node/3088 进程。其他 CiteRAG/RepoPilot 资源未动。

授权为本轮最多 12 次、512 输出 tokens/次、5 元，仅合成内容。费用按 [DeepSeek 官方价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) 2026-10-01 的高峰输入未命中 2 元、输出 8 元/百万 tokens，采用偏大的输入规划因子，12 次上界规划 1.818624 元；不是实际消费金额，未核对服务商账单，也不是账户硬限额。凭证仅从项目外既有配置读取，没有保存进证据。

## 失败和后续修正

- 合成 fixture 的 `core.autocrlf` 本地配置被产品白名单拒绝；删除该探针配置，未放宽产品边界。`.test.mjs` 原生纳入与 `.test.ts` 默认排除的真实契约不同，探针分别断言并记录，未强行改写归属。
- 浏览器前两次失败，分别保存为 [第 1 次](completion-live-browser-report.json)与[第 2 次](completion-live-browser-report-2.json)，请求均为 **0**，未创建应用沙箱。最后定位为首次声明/配置弹层：探针等待声明显式消失，并在本次合成 Host 中注入同一项目外 key，使旧 carrier 完成配置；没有改产品 UI 或跳过声明。第 3 次真实闭环通过。
- 独立只读审阅指出脚本失败收尾可能先统计请求、后停止执行，以及回收未确认仍停止服务。抽出 `finalizeCompletion`，4 项回归先失败再通过：收束后计数、未知资源保留服务、计数未知不写零、未知执行不报收束。两脚本均接入。第二次审阅确认 P2 修复。
- **真实/无模型沙箱报告生成早于最后的脚本收尾修正**；产品 `src` 没有改变，最终脚本异常收尾由离线回归验证，没有重新花模型额度或创建第三个沙箱。总报告的最终 Hash 不冒充历史执行时 Hash。
- 修正后的真实入口对同一已存在授权回执实际返回 EEXIST，[重复启动报告](completion-repeat-guard-report.json)确认请求预留 0、未启动服务/模型/沙箱，最终收尾助手正常执行；不是再次真实模型复验。
- Minor：收尾助手之后 Docker 查询、路径检查或临时目录删除若自身抛错，仍可能中断最终 JSON 输出。记录为证据探针健壮性缺项，不据此改写本次已实际确认的清理结果。

## 复验

最终全量为 **120 项：119 通过、1 项 Windows Git 执行位条件跳过、0 失败**；固定 OCR 共享回归 **49/49**。类型检查、构建、最终构建后的历史模式浏览器与 Web smoke 均通过；包 dry-run 含 43 个文件，未安装或发布。17 份 Markdown 的 235 个本地引用、14 份 R4 JSON、63 个源码 Hash 和 39 个构建 Hash 核对通过；25 个改动路径无凭证样式或空白问题，产品 `src` 未改变，远程 HEAD 仍为 `596f1bd`。

先核对服务、Docker、工具与授权；只对一次性合成仓库执行。已有固定安装根与 CLI 路径在本机，示例用占位，不能由脚本开关推导用户授权。

```powershell
$env:ITEROOM_OCR_BIN = '<固定官方 OCR v1.12.9 CLI 绝对路径>'
$env:ITEROOM_SANDBOX_POC_ROOT = '<项目外 R0 固定安装根>'
$env:ITEROOM_R4_COMPLETION = 'synthetic'
node scripts/r4/completion-smoke.mjs
$env:ITEROOM_PLAYWRIGHT_CLI = '<项目外 playwright-cli.js>'
node scripts/r4/browser-smoke.mjs
node --test test/r4-completion-cleanup.test.js
npm.cmd test
npm.cmd run check
npm.cmd run build
npm.cmd run test:web
node --test test/r0-ocr-delegate.test.js test/r0-review-input.test.js test/r0-fixed-review-copy.test.js
npm.cmd pack --dry-run --json --ignore-scripts
git diff --check

# 仅在新的请求/费用/数据授权后运行真实复验；两种真实入口不能并用：
$env:ITEROOM_MODEL_KEY_FILE = '<项目外 DeepSeek 配置>'
$env:ITEROOM_R4_AUTHORIZATION_FILE = '<TEMP 直属目录内新的本轮授权回执文件>'
$env:ITEROOM_R4_LIVE_BROWSER = '1'
node scripts/r4/completion-live-browser.mjs
```

同一回执存在则拒绝该次尝试；这防止重复启动，不是可以自行生成授权的产品权限机制。`completion-smoke` 的 `live` 是替代 CLI 入口，本轮没有运行，仅浏览器真实入口有通过证据。不能同时运行两者或复用已耗额度。

## R5 接续边界

进入 R5 前先固定实施计划。P0-07/A05 的新增/删除/重命名**补丁执行与接受**仍缺；R4 审查输入能展示这些类型不等于修改工具支持它们。无变更目标复查、cleanupPending 显式解除、完整 DSH 历史清除、配置/预算/权限 UI、Host/编辑器原子性、真实用户项目、干净安装与支持矩阵仍需逐项验收。旧完整 DSH Web 入口仍有宿主工具，不属于受管隔离保证。R0–R4 最小阶段退出通过不等于完整产品 A01–A21 或 v1。
