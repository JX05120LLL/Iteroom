# R5-1 运行状态与预算可见性 · 2026-10-05

R5-1 在固定 Windows / Node 24.14.0 / DSH Web 开发入口和一次性合成项目范围内完成。它只展示受管任务的配置状态与请求上限；**R5、完整 P0/A01–A21 和 v1 均未通过**。原工作目录的在途改动被保全到独立 `codex/r5-1-runtime-status` 分支，本页所述复验在该分支的隔离副本进行。提交、远端 CI 和发行结果以交付时另行记录为准。

## 接口与行为

- 现有认证 Web Connection 承载 `GET /api/iteroom/runtime`：只读取项目外模型/沙箱配置和协调器预算，不向服务商或沙箱服务发请求，不创建任务。缺失、无效和已配置分别显示；已配置不等于账户、镜像或执行可用。
- `POST /api/iteroom/runtime/sandbox-check` 要求同源、空 JSON、无查询参数；只向固定回环 OpenSandbox 服务请求一页受过滤的沙箱列表。传输拒绝重定向、其他地址和其他动作，响应限制 64 KiB，超时后取消请求并关闭 SDK 客户端。同配置并发检查复用一个探针，尚未收束的探针不会被重放。
- 理解、修改、审查三个受管页面沿用方案 C 的内联状态面板，显示模型/沙箱配置、连接观察与实际协调器预算。刷新配置清除旧连接观察。前端状态仅供用户判断，开始任务时仍由 Host 校验。凭证、私有路径、沙箱清单和原始异常不进入响应。

## 本轮实测

| 层次 | 执行与结果 | 边界 |
|---|---|---|
| 离线专项 | `node --test test/managed-runtime-status.test.js`：14/14 通过；其中新增两项本机半开 HTTP 测试分别在响应头、响应体停滞时用固定 SDK 核对请求取消、底层 TCP 关闭及客户端收束 | 本机合成服务，不是实际 OpenSandbox 部署 |
| 项目门禁 | `npm.cmd test` 共 134 项：129 通过、5 跳过、0 失败；`npm.cmd run check`、`npm.cmd run build`、`npm.cmd run test:web` 通过。`npm.cmd pack --dry-run --json --ignore-scripts` 列出 44 个文件，含新运行模块和客户端 bundle | 5 项跳过含需独立 OCR 条件的场景及 Windows Git 执行位；打包仅检查清单，未安装或发布。Web smoke 使用合成 Git 项目和回环模型桩 |
| 浏览器 | [390×844 合成报告](runtime-browser-report.json)与[截图](runtime-status-390.png)：生产按钮展示三个受管入口、预算、服务可连接/不可连接、刷新；GET 不触发服务；检查仅发送三个 `GET /v1/sandboxes`；源项目 HEAD/index/status 不变 | 真实 Chromium + 固定 SDK + 回环服务桩；模型请求 0，实际沙箱分配 0 |

本轮浏览器复验为新构建的客户端，报告中的 `clientHash` 对应本次生成物；不能用先前原会话报告的 Hash 代替。构建在受限隔离执行环境中因无法遍历 C 盘父目录失败；同一源码和依赖经获准的本地执行构建通过。此失败归于执行环境路径限制，不计为产品测试通过。

## 仍未验收

实际 OpenSandbox 服务、镜像创建与销毁、真实模型账户/费用、真实用户项目、其他平台、干净 tarball 安装与远端 CI 未由 R5-1 验证。服务检查只证明列表 API 在检查当时可达，不提升为执行就绪。若 SDK 或底层传输永久不响应关闭，探针保持待收束并复用失败结果；R5-1 不提供强制回收外部 SDK 资源的保证。旧完整 DSH Web 入口仍有宿主工具，不属于受管隔离保证。

下一切片仍按 [R5 计划](PLAN.md)逐项定义新增、删除和重命名文件的修改、补丁、冲突与接受恢复协议，再做实际沙箱验证；本轮未扩展补丁类型。

## 2026-10-06 CI 复核

- Windows / Node 24 CI 首次运行 [def1236](https://github.com/JX05120LLL/Iteroom/actions/runs/37330748132) 因快照数据目录的短路径/真实路径比较出现 30 项失败。本地目录联接回归测试先复现 `SNAPSHOT_INVALID`，随后修复为使用真实数据目录边界。
- 第二次运行 [ce6c6a7](https://github.com/JX05120LLL/Iteroom/actions/runs/37332146989) 已消除上述 30 项失败，仍有 6 项失败：5 项评审准备把 Windows 临时目录别名误判为非托管仓库，1 项取消状态测试依赖固定 30 ms 延时。工作区中的修复使评审临时目录在创建前规范为真实路径，保留严格目录校验；取消测试等待实际状态并保证释放等待中的运行器。
- 当前本地定向评审测试为 19 项、17 通过、2 条件跳过；完整 `npm.cmd test` 为 136 项、131 通过、5 条件跳过、0 失败。`npm.cmd run check`、`npm.cmd run build`、`npm.cmd run test:web` 通过。上述测试使用隔离项目、本地服务和模型桩，无真实模型请求或沙箱分配。
- 远端门禁以最终提交 SHA 对应的 GitHub Actions 结果为准；本地通过不代替远端验收。R5-1 之外的 R5 和 v1 总体验收仍未通过。

## 2026-10-06 Web 冒烟复核

- [ebc34ba 的 CI](https://github.com/JX05120LLL/Iteroom/actions/runs/37429638013) 中 `npm.cmd ci`、`npm.cmd test`、`npm.cmd run check`、`npm.cmd run build` 通过；`npm.cmd run test:web` 失败，终态任务的 `changes` 暂为空。Windows 临时目录短路径使会话保存的原始 `cwd` 与快照中的真实路径不同，证据结束与显示代码原先将两者直接比较。
- 新增目录联接回归测试先复现空变更，修复后验证运行中和终态读取均可显示变更；另一测试确认联接改指后拒绝把新目录的内容归因于原任务。Web 冒烟现在等待终态证据持久化后检查 Diff。仓库外临时目录联接模拟运行、本地普通 Web 冒烟均通过。
- 修复后的本地 `npm.cmd test` 为 138 项：133 通过、5 条件跳过、0 失败；`npm.cmd run check`、`npm.cmd run build`、`npm.cmd run test:web` 通过。曾将临时目录联接放在 Iteroom 仓库深处的额外诊断运行因 Windows 路径过长在快照创建时报 `ENOENT`；该人工嵌套布局不是 CI 路径，未计入门禁通过。后续须以新提交 SHA 的远端 CI 结果确认 R5-1。
