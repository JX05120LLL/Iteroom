# R3 用户接受与恢复：限定证据

最新 [2026-10-01 自测](RETEST-2026-10-01.md)与[匿名报告](retest-2026-10-01-report.json)补充并发缺陷的失败复现、修复回归和最新实际沙箱/浏览器复验。下方保留原阶段证据和既有范围；本次模型请求仍为 0。

环境：Windows、Node 24.14.0、固定 DSH 0.1.5-rc.3/OpenSandbox SDK 1.1.0；输入均为一次性合成文本/Git 仓库。本切片无 DeepSeek 请求、无用户源码传输或项目部署。R2 的真实模型证据见 [R2](../r2/EVIDENCE.md)，本次实际沙箱联测使用模拟模型。

| 场景 | 已验证事实 | 边界 |
|---|---|---|
| 冲突与脏工作树 | 任务快照后外部编辑使接受返回 `ACCEPT_CONFLICT` 且目标原样保留；合成 Git 仓库原本脏文件在与快照一致时可接受，Git index 内容与 HEAD 不变 | 仅现有选定源文件；无新增路径冲突测试 |
| 用户决策 | `accept` 写回产物后的字节，重复同一 `requestId` 返回完成态；`discard` 不写源文件，之后不能接受；补丁仍可导出 | 没有真实用户项目验收 |
| 部分失败与恢复 | 注入首文件写后失败，任务为 `interrupted`，已写/未写文件可见，后续任务被阻塞；新 Store 实例显式 `finish` 或 `rollback` 均可完成。遗留 `applying` 启动时只转 `interrupted`，不重放。恢复前外部改写已写文件时返回冲突，不覆盖；首文件写后外部再次编辑使最终哈希检查拒绝虚报 `completed` | 故障是进程内注入，非真实突然断电或恶意并发编辑 |
| 历史删除 | 活动任务拒绝；已取消任务的项目外快照/记录清理，项目源码保留；注入清理失败保留 `deleting` 并用同一请求重试；路由拒绝跨来源和额外字段 | 清理失败为注入，非真实文件系统故障 |
| 实际沙箱到接受 | [匿名报告](sandbox-accept-report.json)：模拟模型经实际 DSH Loop/实际 OpenSandbox 修改合成文件、`node --test` exit 0、候选补丁 `git apply --check`；沙箱清理后接受，写回源文件，Git HEAD/index 不变，所属服务已停止 | 模型模拟，未复验真实 DeepSeek 或用户仓库；R2 限定候选格式 |
| 真实浏览器 | [匿名报告](browser-report.json)：本地 Chromium/Playwright CLI 在 390×844 宽度进入修改面板、下载补丁、点击接受并看到完成态、删除历史；另一合成任务注入部分写回后通过 UI 点击回滚，文件回到快照内容 | 页面任务/产物由合成夹具预置，不是用户项目或实际模型生成 |

`npm.cmd test` 已包含 R3 测试；具体本次计数与命令结果以 [STATUS](../STATUS.md) 为准。可复验：

```powershell
node --test test/managed-acceptance.test.js test/managed-history.test.js test/managed-modify-route.test.js
npm.cmd run check
npm.cmd test
npm.cmd run build
npm.cmd run test:web
npm.cmd pack --dry-run --json --ignore-scripts
git diff --check

# 实际 OpenSandbox + 模拟模型 + 接受；仅一次性合成仓库，需项目外固定服务安装根：
$env:ITEROOM_SANDBOX_POC_ROOT = '项目外 R0 固定安装根的绝对路径'
$env:ITEROOM_R2_MODEL_SMOKE = 'accept'
node scripts/r2/model-smoke.mjs

# 本机浏览器合成 UI；CLI 位于项目外：
$env:ITEROOM_PLAYWRIGHT_CLI = '项目外 playwright-cli.js 的绝对路径'
node scripts/r3/browser-smoke.mjs
```

**ROADMAP R3 的最小退出条件在固定 Windows/Node/DSH/OpenSandbox/合成现有 UTF-8 文件范围内通过。**冲突、脏工作树、用户决策、部分失败、显式恢复、历史清理和浏览器交互均有分层证据。P0-07/A05 所需新增、删除、重命名仍未实现；A14 的新增路径冲突也未覆盖。真实断电、OS 级并发竞态、真实用户仓库、干净发行与旧 DSH Web 宿主工具隔离均不在上述验证结论内，不能称 v1 完成。
