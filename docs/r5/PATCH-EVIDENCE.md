# R5-3 四种文本补丁验证

2026-10-09，Windows x64 / Node 24.14.0 / Git 2.47.1.windows.2。父基线 `main / 5e904d9b7a4c62ee4b1a5bded0baab42a621b1cd` 已在远程，本轮开发改动未提交或推送。规格见 [PATCH-CONTRACT](PATCH-CONTRACT.md)，计划见 [PATCH-PLAN](PATCH-PLAN.md)。

后续同日用户授权提交该切片；提交前重新执行的检查、当前源码/构建 Hash 和暂存范围见 [提交复验](patch-contract-push-2026-10-09-report.json)。本页与原交付报告的未提交字段属于开发验证时状态，不替代实时 Git。没有扩大产品接线或模型/沙箱范围。

## 实现与产品边界

新增内部纯模块 `src/host/managed-patch-contract.js`：定义固定 scope，创建/重建 v2 候选，生成应用与 finish/rollback 恢复计划。范围区分 absent 与零字节文件，关联任务、清单和产物 Hash；模型不能扩大批准路径。16 路径、单侧 256 KiB、侧内容与 diff 各 1 MiB、JSON 2 MiB。拒绝路径别名/前缀碰撞、测试文件写入、端点重复、任意 diff 替换、字段篡改、异常 UTF-8、NUL、稀疏/带附加属性数组及非字符串路径。

产品 API、协调器、快照/产物 Store、沙箱工具及 UI 不调用 v2。内部模块随包构建，没有增加公共 exports、依赖或第二套 Loop。当前修改流程仍只修改选定现有文本。旧 v1 产物冷读通过，v2 及伪装为 v1 的 v2 输入保存被拒绝，旧产物目录与源文件未污染；无用户数据迁移。

## 分层结果

| 层次 | 实际结果 | 限制 |
|---|---|---|
| 新契约测试 | 17/17；含全部串行完成前缀、在途步骤及中断 rollback，未知外部状态拒绝 | 状态输入由测试提供，无真实写回日志或文件恢复 |
| 兼容相关回归 | 契约/Artifact/旧 Acceptance 合计 29/29 | 合成项目，v1 原行为，不证明 v2 产品集成 |
| 实际 Git 导出 | 八操作：四种类型各两个；apply --check、apply、reverse --check、reverse 全通过 | 一次性合成 Git，不经产品接受或沙箱 |
| 内容与工作树保护 | 空文件、纯 rename、带修改 rename、UTF-8 BOM/中文、CRLF、无尾换行通过；七原文件 Hash、readonly 测试、HEAD/index/status 恢复一致 | 导出反向应用验证，不是断电恢复或跨编辑器原子性 |
| 恢复探针 | 11 个纯正向前缀分别生成 finish/rollback，逆向计划回到基线 | 仅元数据计划；测试另覆盖 rollback 中断前缀 |
| 故障清理 | 初始化前主动失败，finally 删除本次临时根，匿名报告记录预期失败 | 不启动模型/沙箱/服务；故障报告 success=false 是预期 |
| 全量回归 | 158 项，157 通过、1 Windows Git 可执行位条件跳过、0 失败 | 实际固定 OCR CLI、原 DSH 配 mock；无真实模型/实际沙箱 |
| 构建与入口 | check/build/test:web 通过，dry-run 45 文件，模块源码/构建 Hash 一致 | Web smoke 不是浏览器验收；新包尚未重复仓库外安装 |

首轮全量曾因合成 Git 测试的 raw index Hash 不一致失败。受控实验确认：`git status` 默认可刷新 stat cache，即使工作树字节无变更，也会改写 index；设置 `GIT_OPTIONAL_LOCKS=0` 后 status 仍报告干净且 index 字节不变。只调整本次合成 Git 子进程环境，继续保留原始 index 断言，没有修改系统/用户 Git 配置。修复后最终全量如上。

独立只读审阅指出稀疏数组、空路径与初始化清理问题；均经失败回归或预期故障探针修复。另补 JSON 非字符串路径的安全拒绝。最终审阅没有未解决的 Critical/Important。只读审阅和离线单测不代替运行授权或 Host 路径安全。

## 证据与复验

[最终成功报告](patch-contract-final-2026-10-09-report.json)和[预期故障报告](patch-contract-fault-2026-10-09-report.json)的 moduleHash/probeHash 与当前文件一致。[交付核对](patch-contract-delivery-2026-10-09-report.json)记录检查、源码与构建 Hash。早期 [成功报告](patch-contract-2026-10-09-report.json)保留历史结果，早于最后边界修正，不替代最终报告。报告只保存合成文件 Hash，不保存用户源码、凭证或临时私有路径。

在仓库根执行（新的探针名称避免覆盖原证据）：

```powershell
node --test test/managed-patch-contract.test.js test/managed-artifact.test.js test/managed-acceptance.test.js
node scripts/r5/patch-smoke.mjs patch-contract-recheck-20261009
node scripts/r5/patch-smoke.mjs patch-contract-fault-recheck-20261009 --fail-initialization
$env:ITEROOM_OCR_BIN = Join-Path $env:LOCALAPPDATA 'Iteroom/tools/ocr/v1.12.9/opencodereview-windows-amd64.exe'
npm.cmd test
npm.cmd run check
npm.cmd run build
npm.cmd run test:web
npm.cmd pack --dry-run --json --ignore-scripts
git diff --check
```

OCR 须为已核对的 v1.12.9 Windows x64，SHA-256 `ae6f4785fea34a5cfef93ad22d8e7fb8032bbd12c45f2cbcc98cbe1b38cceff1`。缺工具不能把 mock/跳过写成实际 CLI。探针仅在自己的临时目录初始化合成 Git、禁用外部 hooks/签名并清理；不会修改用户项目或 Git 配置。

## 未验与下一步

本轮真实模型请求、实际沙箱分配、用户源码外传均为 0，没有新浏览器交互验收。纯 scope/observations/journal 校验不证明真实路径、授权、磁盘状态或执行已停止；这些值必须由可信 Host 捕获并持久化，恢复前须确认活动写入者已收束。

下一切片实现独立 `managed-snapshots-v2` / `managed-artifacts-v2`：安全缺失目标、已存在父目录及链接/身份核对、内容和 scope 冷读校验、取消等待、旧目录不混写。之后再接显式操作批准、沙箱工具/库存、UI 格式分派和受控写回。真实 v2 文件日志/部分失败恢复、模型/沙箱组合、其他平台、权限票据、数据管理与完整发行仍待分别验收。A05/A14/A15/A18、R5 与 v1 尚未完成。
