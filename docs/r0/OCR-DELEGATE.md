# R0 OpenCodeReview Delegate 契约验证

2026-09-27 · 独立合成 Git 探针，正式产品未接 OCR。真实 CLI 切片通过；Gate B、R0 和 v1 均未完成。

## 固定工具与来源

- 官方 [v1.12.9 Release](https://github.com/alibaba/open-code-review/releases/tag/v1.12.9)，Windows amd64 资产 `opencodereview-windows-amd64.exe`。
- tag 对应源提交 `bccbc15f785269400735d5255540c231e6c02b6d`；实际 `--version` 为 `open-code-review v1.12.9 (bccbc15f) windows/amd64`。
- 发布的 [sha256sum.txt](https://github.com/alibaba/open-code-review/releases/download/v1.12.9/sha256sum.txt) 与下载文件一致：`ae6f4785fea34a5cfef93ad22d8e7fb8032bbd12c45f2cbcc98cbe1b38cceff1`。探针每次启动前再次核对哈希，其他版本/平台不冒充已验证。
- 环境：Windows x64、Node 24.14.0；Git 实际版本见[匿名报告](ocr-delegate-report.json)。不安装全局命令或新增产品依赖；工具与源码检查在项目外临时目录。
- 早先 `486022d` 是研究快照，本轮选择明确发行版验证，不宣称两个快照的全部行为相同。许可 Apache-2.0；本轮未复制规则正文或分发二进制。

## 实际接口

固定版源码：[Delegate JSON](https://github.com/alibaba/open-code-review/blob/bccbc15f785269400735d5255540c231e6c02b6d/cmd/opencodereview/delegate_cmd.go)、[参数](https://github.com/alibaba/open-code-review/blob/bccbc15f785269400735d5255540c231e6c02b6d/cmd/opencodereview/shared_flags.go)。实际执行形式如下；路径与修订由合成仓库产生，采用参数数组：

```text
ocr delegate preview --repo <managed-repo> --format json --max-git-procs 2
ocr delegate preview --repo <managed-repo> --format json --commit <full-commit-sha>
ocr delegate preview --repo <managed-repo> --format json --from <full-sha> --to <full-sha>
ocr delegate rule --repo <managed-repo> --format json [same mode flags] -- <validated-paths...>
```

`schema_version` 为字符串 `"1"`，不是数字。preview 含 `mode/repository`、可选 `from/to/commit/merge_base`、文件/行数合计、`reviewable_files/excluded_files`。文件含 `path/status/insertions/deletions`，排除项另含 `exclude_reason`。rule 的 groups 含 `group_id/source/pattern/files/rule`，表示规则及来源相同，不是语义分组。

解析器检查 schema、模式、仓库、修订及 merge-base，并与独立 `git diff --name-status -z --find-renames` 和未跟踪清单比较。重复、缺失、额外、状态失配、统计不一致、非法路径、空规则或规则覆盖不足均拒绝。路径保守拒绝目录穿越、绝对/UNC/驱动器路径、`.git`、控制字符、ADS、Windows 保留名称和歧义字符；这是探针边界，不代表产品快照/符号链接隔离已完成。

## 三种输入的真实结果

同一组数据包含 staged 新增/修改/删除/重命名、一个未跟踪新增、测试修改与 tracked vendor 修改。先测工作树，再提交整组变更测单提交，最后增加空提交测跨多个提交的范围。提交仅发生在一次性合成仓库。

| 文件 | 状态 | 默认处理 | 显式 include 后 |
|---|---|---|---|
| src/added.ts | added | 审查 | 审查 |
| src/untracked.ts | added | 工作树时未跟踪，仍纳入 | 审查 |
| src/greet.ts | modified | 审查 | 审查 |
| src/renamed.ts | renamed | 审查；旧路径由 Git 取得 | 审查 |
| src/gone.ts | deleted | 排除：deleted | 仍排除 |
| test/greet.test.ts | modified | 排除：default_path | 审查 |
| vendor/lib.ts | modified | 排除：provider_directory | 仍排除 |

每种模式默认 7 项/4 可审查/3 排除，显式 `--rule` 指向 `{ "include": ["test/**/*.ts"] }` 后为 5 可审查/2 排除。全部待审文件取得非空规则、来源和规则哈希。调用前后比较合成文件内容、Git 状态与 HEAD，确认 Delegate 未修改输入。仓库最终清理；报告不含本机仓库路径、原始源码、规则正文或会话记录。

preview 重命名没有 old path；仅凭它不能生成完整补丁或旧侧上下文。删除不进入 OCR 默认待审集合，Iteroom 后续仍需显示删除覆盖并取得固定基线旧内容，不能将它隐藏或伪装成已审查。

## 失败路径与检查结果

- **实际 OCR CLI**：损坏规则 JSON、缺失规则文件、无效 commit、不完整范围、不支持的 format 均非零退出，保存 `process_failed` 与退出码，不保存 stderr 原文。
- **离线契约与实际 Node 子进程**：异常 JSON、版本失配、统计/规则不完整、越界/未知路径、参数数组、环境隔离、spawn/退出失败、超时、合并输出超限。超时测试启动真实孙进程并检查其 PID 已不存在，不用 mock 代替停止证据。
- 执行器默认 10 秒/合并 stdout+stderr 1 MiB；Windows 停止自己启动的进程树，停止未确认报 `termination_unconfirmed`。关闭管道或断连不被宣称为进程树停止。
- OCR 新增测试 **18/18**；DSH+OCR 独立 R0 合计 **35/35**。现有产品测试 **19 通过/1 Windows executable-bit 场景跳过**；类型检查、构建通过。`npm test` 仍不包含 R0，需单独运行。
- 未复验 Web smoke/浏览器；未运行真实模型、部署 OpenSandbox 或发行安装。A01–A21 完整产品验收状态不变。

## 复验

下载为显式开发步骤；探针和测试不会自动联网安装工具。以下只取得公开固定发行文件：

```powershell
$ocrToolHome = Join-Path $env:TEMP ('iteroom-r0-ocr-tool-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $ocrToolHome | Out-Null
$env:ITEROOM_OCR_BIN = Join-Path $ocrToolHome 'opencodereview.exe'
Invoke-WebRequest -Uri 'https://github.com/alibaba/open-code-review/releases/download/v1.12.9/opencodereview-windows-amd64.exe' -OutFile $env:ITEROOM_OCR_BIN
if ((Get-FileHash -LiteralPath $env:ITEROOM_OCR_BIN -Algorithm SHA256).Hash.ToLowerInvariant() -ne 'ae6f4785fea34a5cfef93ad22d8e7fb8032bbd12c45f2cbcc98cbe1b38cceff1') { throw 'OCR binary checksum mismatch' }
node --test test/r0-ocr-delegate.test.js
node --test test/r0-dsh-contract.test.js test/r0-dsh-loop.test.js test/r0-ocr-delegate.test.js
node scripts/r0/ocr-delegate.mjs
npm.cmd run check
npm.cmd test
npm.cmd run build
```

未设置 `ITEROOM_OCR_BIN` 时离线用例仍运行，真实 CLI 集成用例明确跳过；探针返回 unavailable/非零退出。缺失、平台未验证或哈希失配不会退回 mock 或调用另一版本。

下一切片仍属于 Gate B：固定输入的旧/新侧定位与完整 diff、复杂范围/merge-base、空变更及路径/符号链接边界，补足产品覆盖策略。当前仅有合成线性历史和普通文件证据，不提前迁移 R1/R2。

接续记录：[REVIEW-INPUT](REVIEW-INPUT.md)已扩展上述旧/新侧、分叉/root/merge、空输入与链接边界；本页原始报告保持历史证据，不把后续结果改写成首次切片已经完成。
