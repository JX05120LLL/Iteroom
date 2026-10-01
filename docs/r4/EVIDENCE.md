# R4-1：产品审查准备证据

本文保留 R4-1 当时实现/测试和 `preparation-report.json` 的历史 Hash；当前增量及源码 Hash 见 [R4-2 证据](INFERENCE-EVIDENCE.md)。后续已启用审查推理入口，旧截图/按钮描述不代表最新 UI。

2026-10-01，本轮在 `3d21332` 基线上保留 R3 未提交修复，完成 R4 的第一个产品切片。R4-1 准备链路通过；**R4、A08 完整任务、A09/A10 与 v1 未完成**。所有输入为一次性合成仓库，真实模型请求 0、用户源码传输 0；没有部署沙箱、提交或推送。结构化结果见 [匿名报告](preparation-report.json)。

## 实现范围

- 当前启动项目的工作树、单提交、提交范围进入受管 `review` 任务；同一 requestId 固定输入不变，重复请求不重采。准备完成仍为 queued/not_started，无 DSH Session，不能从准备状态推断审查完成。
- Iteroom 原 R0 Git/输入/副本/进程/JSON 模块提升为共享 Host 模块，旧 R0 导出保留。用户目录不作为 CLI cwd；OCR 只读取重建的临时 Git 副本，准备前后复核。SHA-1 完整修订、first-parent/empty-tree/唯一 merge-base 语义保留。
- 固定官方 Windows amd64 OCR v1.12.9，源提交 `bccbc15f785269400735d5255540c231e6c02b6d`；可执行文件 SHA256 `ae6f4785fea34a5cfef93ad22d8e7fb8032bbd12c45f2cbcc98cbe1b38cceff1`。每次准备验证普通外部文件/Hash/实际版本，调用 Delegate preview/rule，不运行其审查 Agent。[官方版本](https://github.com/alibaba/open-code-review/releases/tag/v1.12.9)。JSON schema 严格为字符串 `"1"`；未知模式/路径/条目/统计/规则覆盖拒绝。
- 测试源码显式 include，删除文本使用旧侧规则与 Diff，重命名保留两侧路径。固定版省略未跟踪 provider 目录，产品依据 [固定源契约](https://github.com/alibaba/open-code-review/blob/bccbc15f785269400735d5255540c231e6c02b6d/internal/diff/git.go)仍记录其排除原因，其他缺失不静默忽略。敏感/provider/二进制排除项的准备正文与 Diff 为 null，不进入持久规则组。
- 项目外准备记录由 `reviewSnapshotId` 关联整个 JSON Hash，含 OCR provenance/rule Hash；源文件后来改变仍展示原准备。篡改拒绝，历史删除同时清理所属准备目录。新程序兼容旧任务格式；旧程序不能解析新 kind，回退前备份。
- 保留白色方案 C、双拱门 Logo 与旧入口，新增“变更审查”。显示固定 Diff、覆盖/原因、放弃和删除；“开始审查（待接入）”禁用。

## 已执行检查

| 层次 | 实际结果 | 边界 |
|---|---|---|
| R4 专项 | 8/8 通过 | 6 项合成/注入回归，2 项实际固定 CLI；无模型 |
| 最终 npm test | 92 项：91 通过，1 Windows 执行位跳过，0 失败 | 显式配置 OCR，包含实际 CLI；沙箱测试使用既有 mock |
| R0 输入/副本/Delegate 回归 | 49/49 通过，0 跳过 | 三项实际 CLI 集成，其余 Git/边界/真实进程或注入测试；与 npm test 分开执行 |
| 类型检查/构建 | 通过 | 未做干净环境安装 |
| Web smoke | 通过 | 真实认证载体、R1 路由/重启、旧开发入口本地模型 stub；不声称审查推理 |
| R4 Chromium 浏览器 | 通过，390×844 | 实际工作树 OCR 准备、测试纳入、删除旧 Diff、provider 不展示正文、推理禁用、放弃/删除；单提交/范围只检查表单，执行由专项真实 CLI 验证 |
| 包 dry-run | 36 项 | 新协调器/快照、10 个共享模块与 bundle 在内；没有生成 tarball、安装或发布 |

专项核对实际三种输入每种 7 个变更：6 项 pending_inference、1 项 provider 排除；测试纳入、删除旧侧、重命名来源和规则覆盖准确。另一实际工作树加入敏感与未跟踪 provider 文件，共 9 项；排除正文不保存。三种模式准备前后源 HEAD/index/status 一致；源内容后来编辑与快照读取的差别由合成回归核对。

新增收束回归先失败：终止无法确认没有持久记录，重启后可误放弃。修正后只保存安全错误码并持久 `reviewCleanupPending`；重启后的取消和准备拒绝，不泄露故障正文。该异常来自注入，不是本次实际 OCR 失控进程；正常 CLI 和进程超时/树停止另经真实运行回归。收束无法确认时仍保留项目任务位，当前需要人工核对，没有自动解除动作。

最终 review 补充字段顺序回归先失败：同一提交的 JSON 字段顺序变化触发 REQUEST_ID_CONFLICT。输入现在按 mode/修订 canonical 化；任务元数据与三种实际 CLI 模式重试都验证不同字段顺序仍复用同一准备记录。

## 复验

在项目根 PowerShell 中，设置外部已安装工具后执行（路径由本机配置，不提交凭证或私有绝对路径）：

```powershell
$env:ITEROOM_OCR_BIN = '<官方固定版 Windows x64 可执行文件绝对路径>'
node --test test/managed-review.test.js
node --test test/r0-ocr-delegate.test.js test/r0-review-input.test.js test/r0-fixed-review-copy.test.js
npm.cmd test
npm.cmd run check
npm.cmd run build
npm.cmd run test:web
$env:ITEROOM_PLAYWRIGHT_CLI = '<项目外已安装 playwright-cli.js 绝对路径>'
node scripts/r4/browser-smoke.mjs
npm.cmd pack --dry-run --json --ignore-scripts
git diff --check
```

没有 OCR 环境变量时专项两项集成跳过，不能声称实际 CLI 通过。普通准备无需模型或 Docker；不要带入真实模型调用环境、真实源码或业务数据。现有保守上限为 100 个变更、单文件 256 KiB、两侧和 Diff 各 1 MiB、所有 Git 对象 1000 个/16 MiB；大仓库/其他平台/attributes/filters/includes/worktree `.git` 文件不支持。

## 未完成

R4-1 当时尚未接 DSH 审查推理、分组/预算、结构化发现、片段定位与部分推理覆盖；这些已由后续 R4-2 实现并以本地模拟模型验证，详情见新证据。关联修复与新快照复查仍未接入。真实模型额度需要另行授权，旧 R2 额度已经用完。多 Host 互斥、原子采集、OS 只读副本、真实用户项目、更多补丁类型与发行未验；本轮没有重新跑实际沙箱，不外推为沙箱验收。下一步按 [R4 计划](PLAN.md)推进 R4-3 与真实审查模型单独授权复验。
