# R5-1 运行配置与预算证据

后续 [R5-2 安装证据](INSTALLATION-EVIDENCE.md)已补独立消费项目和取消恢复；本文及交付报告保留 R5-1 当时检查数与范围，不能作为后续协调器/客户端改动的最终 Hash 证据。

2026-10-09 · Windows / Node 24.14.0 / DSH 0.1.5-rc.3 / OpenSandbox SDK 1.1.0。交付父基线 main / `1fbaa41`；本轮用户授权提交推送，真实模型请求、用户源码传输、实际沙箱分配均为 0。R0–R4 的限定退出保持原范围；R5、完整 P0 和 v1 未完成。

## 实现与实际验证

- 认证 GET 仅读既有配置与实际任务请求预算；不初始化/恢复任务。POST 必须同源、JSON、无查询、精确空对象，仅查询固定本机服务的单页列表，不创建沙箱。凭证、配置路径、列表内容和原始异常不返回。
- 缺失/已填写无效/已配置分开，保留既有备用凭证 loader 规则；配置不等于账户可用。understand 默认 3/256（可配 1–4/1–512），modify/review 4/512；账单未核对，不是人民币硬限额。
- 2.5 秒总 deadline 传递到 HTTP headers/body；完整响应上限 64 KiB，取消读取并关闭客户端。延迟取消/close 期间保留同配置探测记录，重复点击复用结果，收束后才重新检查。拒绝重定向、外部目标、其他路径和非 GET 动作。
- 新增 runtime 12 项；与既有任务/修改路由合计 19/19。真实 SDK 配纯内存流验证 headers/body 超时、取消、每个客户端 finally close、正文超限和延迟清理重入；没有服务或 Docker。
- 最终全量 `npm.cmd test`：132 项，131 通过、1 Windows Git 执行位条件跳过、0 失败。启用经 Hash 校验的真实 OCR v1.12.9，4 项产品 OCR 集成实际执行，没有因缺工具跳过。此前临时 OCR 文件缺失的 4 项失败保留为历史问题，恢复项目外固定工具后复验，不以 mock 替代。
- `check`、`build`、`test:web` 通过。Web carrier 验证运行状态未认证 401、外来源 403、no-store、脱敏及不新增模型请求；旧开发入口的本地模型 stub/宿主工具 smoke 按原范围保留。
- 当前构建的真实 Chromium 390×844，生产 UI/真实 SDK 配合成本机 HTTP：三个页面实际预算、显式检查、503、拒绝重定向、刷新清除连接观察均通过，无横向溢出。固定 GET 3 次，模型 guard 请求 0；合成仓库 6 个文件 Hash、HEAD/index/status 不变，测试服务已停止。这是 HTTP 模拟服务，**不是实际 OpenSandbox 服务/镜像执行验证**。
- package dry-run 44 个文件，包含 runtime Host 和浏览器 bundle；没有私有配置路径。源码构建核对与匿名检查汇总见 [交付报告](delivery-2026-10-09-report.json)。未安装 tarball 或公开发布；独立安装属于下一切片。

## 记录与复验

- [当前浏览器报告](delivery-2026-10-09-browser-report.json)及[截图](delivery-2026-10-09-status-390.png)包含当前 bundle/Host/探针 Hash。10-05 的 [历史浏览器报告](runtime-browser-report.json)及[截图](runtime-status-390.png)保留当时含义，早于最后清理重入修正，不作为新代码的运行时证据。
- 私有原始全量日志保存于本机 `%TEMP%/iteroom-r5-delivery-tests-20261009.log`，匿名计数在仓库报告中。原始日志不提交。

```powershell
$env:ITEROOM_OCR_BIN = Join-Path $env:LOCALAPPDATA 'Iteroom\tools\ocr\v1.12.9\opencodereview-windows-amd64.exe'
Get-FileHash -LiteralPath $env:ITEROOM_OCR_BIN -Algorithm SHA256
node --test test/managed-runtime-status.test.js test/managed-task-route.test.js test/managed-modify-route.test.js
npm.cmd test
npm.cmd run check
npm.cmd run build
npm.cmd run test:web
$env:ITEROOM_PLAYWRIGHT_CLI = '<既有项目外 playwright-cli.js 绝对路径>'
node scripts/r5/runtime-browser-smoke.mjs <本次唯一英文证据名>
npm.cmd pack --dry-run --json --ignore-scripts
git diff --check
```

OCR 固定 SHA256：`ae6f4785fea34a5cfef93ad22d8e7fb8032bbd12c45f2cbcc98cbe1b38cceff1`。工具与凭证均在项目外；脚本只清理自己的合成临时目录，3088 被其他服务占用时失败，不停止他人服务。证据名限定字母/数字/连字符，使用新名称保留历史。

## 未验证与下一步

R5-1 只关闭配置可见性这一局部切片。真实账户有效性、实际 OpenSandbox 可用性/镜像创建、凭证编辑、审批流程、人民币硬限额、更多补丁类型、数据恢复和干净发行均未由此验证。接下来先在仓库外安装当前 tarball 并验证已安装入口，不复用源码 node_modules；随后按 [计划](PLAN.md)扩展补丁协议及其他产品缺项。真实模型需新授权，旧 R4 剩余额度不跨阶段使用。
