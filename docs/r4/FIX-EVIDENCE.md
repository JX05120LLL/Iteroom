# R4-3：关联修复与新输入复查证据

2026-10-01，保留 `3d21332` 基线上的 R3/R4-1/R4-2 和 README 流程图改动。本轮实现候选选择、关联修改任务、来源导航、接受后新工作树准备与独立复查报告。**真实 OCR 与原 DSH CLI 配本地模拟模型通过；修改产物/执行记录来自合成注入，没有运行实际沙箱，也没有请求真实模型。完整 R4/v1 尚未验收。**

计划见 [FIX-PLAN](FIX-PLAN.md)，匿名结果见 [总报告](fix-report.json)与 [浏览器报告](fix-browser-report.json)。旧 preparation/inference 报告保留为对应历史代码的证据，不用旧 Hash 证明本轮实现。

本文件与 fix-report 保留开发验证时的 Git 状态和构建 Hash。随后授权远程交付的最新复验见 [交付记录](DELIVERY-2026-10-01.md)与[匿名报告](delivery-2026-10-01-report.json)；其中单独记录重新构建的浏览器 bundle，历史报告不覆盖。

## 实现与边界

- 新 `ManagedReviewFix` 复用现有 Store、快照、结果、准备和 R2/R3。没有新依赖或第二套 Loop。
- `POST .../review/fix` 精确 `{taskId,findingId,requestId,objective,testPaths}`。只接受完成/部分完成报告中已定位的 new 侧 modified 普通源码；旧侧、删除、重命名及测试目标拒绝。目标整文件 Hash 必须匹配固定发现；用户显式选择 1–15 个已有 `.test.js/.test.mjs/.test.cjs`。路径、链接、UTF-8、文件大小沿用原检查。创建只固定输入，不启动模型/沙箱、不写项目。
- 修改任务原子保存 `reviewOrigin`（原审查、准备、报告、发现、路径和源码 Hash）；开始修复前再次核对固定 Hash。捕获期间变化不能启动引擎或分配沙箱。来源仅由内部参数添加，普通公开 create 不能伪造关系。
- `POST .../review/recheck` 精确 `{taskId,requestId}`，针对已接受的关联修改。读取 Hash 校验的候选产物，核对当前源码及固定测试与接受结果一致，再为当前工作树全部变更创建新的准备记录；OCR 固定副本和准备记录中的修改目标 new side 再次核对。新任务保存 `recheckOrigin`（modifyTaskId/artifactId），不复用旧报告，也不自动开始模型推理。
- 原目标修复后若恢复成 Git 无变更文件，当前工作树差异复查明确返回 `REVIEW_RECHECK_TARGET_MISSING`，不把 no_changes 当作零发现通过。该失败准备可显式放弃/删除，用户项目内容保持不变。
- 同请求/同内容合并，换内容复用请求 ID 拒绝；重启读取既有固定任务，不重新采集变动后的文件或重发模型。Store 加载检查关系形状和父记录，父记录被子任务引用时在锁内拒绝删除；先结束并删除子记录，不自动级联清理。
- 白色 UI 保持既有布局。审查页选择问题、填写目标与测试范围后打开关联修改；修改页展示来源并可返回原审查，接受后可固定新输入并打开复查。真实浏览器验证了历史切换后的同目标再导航，不是只有静态页面。
- 版本仍 v1、字段可选，旧 R1/R2/R3/R4-1/R4-2 记录可读。旧程序不提供新关系删除保护；回退前备份并校验项目外数据，保留新程序恢复数据的能力，没有自动格式迁移。

## 检查结果

| 层次 | 实际结果 | 限制 |
|---|---|---|
| R4-3 新增行为 | 11/11（纳入全量） | 合成文件/Git，执行收据注入；两项实际固定 OCR 集成 |
| 全量 npm test | 116 项：115 通过、1 条件跳过、0 失败 | Windows Git executable-bit 条件跳过；实际 OCR 显式配置，沙箱测试为既有 mock |
| Chromium 390×844 | 通过 | 真实认证页面/API：选候选、创建/跳转/刷新、来源/父删除保护、用户接受、固定新输入、新报告和同目标往返 |
| OCR/DSH | 两次审查输入准备和原 Loop 运行 | 模型 adapter 是本地 mock：原候选 1，新报告候选 0；不是模型审查质量或缺陷复现证据 |
| 实际沙箱/真实模型 | 未运行 | 修改执行与候选是注入的合成收据；本轮真实请求 0、用户源码传输 0 |

最终类型检查、构建、Web smoke、包清单与文档检查计数见 [总报告](fix-report.json)。包清单不等于干净安装或发布，浏览器不会点击生产模型/修改开始按钮。

## 失败发现与修复

独立只读审查发现：关联修改先发布 queued 记录再捕获快照，并发取消/删除可能先遗忘任务，再由捕获发布项目外源码副本。合成回归暂停 capture 后请求 cancel，原行为提前返回，测试实际失败。修复后修改开始/取消和历史删除路由等待同一 `ManagedReviewFix` 的准备 promise 收束；失败准备同样等待收束，再允许取消。回归释放 capture 后完成取消/删除，确认快照目录 ENOENT。本约束是单 Host 产品入口协调；底层快照助手直接并发调用、跨 Host 以及强制崩溃清理不归入已验证保证。

浏览器首轮脚本用了与页面不符的接受按钮名称，定位修正后通过接受与新报告。额外往返检查最初把“再次固定复查”误当作“打开旧复查”：页面重新挂载后新请求确实创建新的 queued 准备，不会复制旧模型结果。改为通过“查看原审查”检查同一目标导航，实际通过，未为假设中的面板缓存问题增加产品改动。

最终自查发现测试目标识别最初仅排除 JS 测试后缀，未拒绝 TypeScript `.test/.spec` 与 `__tests__` 目录候选。回归实际失败后，协调器、存储关系校验和 UI 统一拒绝常见测试路径；固定测试选择仍限现有 `.test.js/.test.mjs/.test.cjs`，没有提前扩展 R2 测试工具。

## 复验

项目根 PowerShell，使用已安装、经验证的项目外工具：

```powershell
$env:ITEROOM_OCR_BIN = '<固定官方 v1.12.9 Windows x64 CLI 绝对路径>'
node --test test/managed-review-fix.test.js
npm.cmd test
npm.cmd run check
npm.cmd run build
npm.cmd run test:web
$env:ITEROOM_PLAYWRIGHT_CLI = '<项目外 playwright-cli.js 绝对路径>'
node scripts/r4/fix-browser-smoke.mjs
node scripts/r4/browser-smoke.mjs
npm.cmd pack --dry-run --json --ignore-scripts
git diff --check
```

两个 browser 脚本只用一次性合成仓库和本地 mock 审查模型；新脚本注入合成修改收据，由真实 R3 API 接受，宿主合成文件仅在该显式接受后变化，HEAD/index 保持不变。结束清理只处理本次资源。没有自动 commit/push/publish。

## 下一步

先核对 OpenSandbox 服务/Linux Docker 和既有合成授权，追加原 DSH mock 工具 → 实际沙箱修改/测试 → 用户接受 → 新输入复查的组合证据。真实审查模型需新授权的请求次数、tokens、费用及仅合成传输范围。原问题已修复的自动关联判定、新/删/重命名补丁、无变更目标复查、真实崩溃/多 Host、cleanupPending 显式解除、完整数据清除、用户项目和干净发行另验。A08–A10、完整 R4 与 v1 保持未完成。
