# R0 审查输入与旧/新侧证据

2026-09-27 · 在[固定 Delegate CLI 切片](OCR-DELEGATE.md)上继续实现独立输入捕获与覆盖验证。本页保留当时切片证据；最新限定范围内 Gate B 收口见[固定副本](FIXED-REVIEW-COPY.md)。产品仍为原 DSH Web 入口，不代表正式快照或审查推理完成。

## 实现与接口

`scripts/r0/review-input.mjs` 的 `captureReviewInput(fixture, input, limits)` 只接受项目外一次性 `iteroom-r0-*` 目录中的 repository。repository、home 和 `.git` 必须是本地普通目录；外部 gitdir 指针/链接被拒绝，Git 环境重新生成。不接受真实项目路径，不是可直接用于用户仓库的产品 API。

输入选择复用固定 SHA 参数约束。输出包含：

- `resolvedBase/resolvedTarget/mergeBase/baseKind`：实际修订，不猜测基线。
- 每项旧/新 `path/mode/blobOid/contentSha256/bytes/content`，不存在的一侧为 null。
- Git 完整文件 diff（包含全部变更块与 Git 默认上下文）、diff 哈希和整体输入哈希；不截断后伪装完整。未跟踪新增通过受控 `git diff --no-index` 生成，退出 1 明确表示有差异，默认进程调用仍只接受退出 0。
- 文本是冻结记录中的不可变字符串，保留 BOM/CRLF；原始字节用于哈希。检测到二进制的侧不提供文本。非 UTF-8 文本明确报 unsupported_encoding，不替换乱码。

默认单文件 256 KiB、工作树读取及变更侧/完整 diff 各受 1 MiB 预算、最多 100 项。超限失败，不悄悄丢失文件。历史侧由选定 Git blob 读取；工作树侧逐级检查目录与普通文件，不解引用目录链接/符号链接，也不读取多链接文件。仅验证这组受管合成输入，不宣称已经实现对恶意真实仓库的隔离。

历史 SHA 内容不随当前工作树改变。工作树捕获前后比较文件、Git 状态和 HEAD；持续改动报 input_changed。返回记录固定，但多次 filesystem/Git 读取不是原子捕获，也不能防范所有瞬时变化后恢复的竞态；OCR 当前仍读同一合成目录并在前后核对。真正从不可变副本调用 OCR 的产品接线仍待验收。

## Git 基线语义

| 输入 | 基线 | 目标/结果 |
|---|---|---|
| 工作树 | 已存在的 HEAD | staged、unstaged、untracked 的当前内容 |
| 普通提交 | 第一父提交 | 指定提交 blob |
| 初始提交 | 空树 | 指定 root commit，全部新增 |
| 合并提交 | 第一父提交 | 合并提交相对第一父的变化，不生成 combined diff |
| 分叉提交范围 | 唯一最佳 merge-base | 比较 merge-base 到 to，排除 from 分支独有变化 |
| 多个最佳 merge-base | 不选择一个 | ambiguous_merge_base，Delegate 前拒绝 |
| 无共同历史 | 无基线 | unrelated_history，不能解释为空变更 |
| 空工作树/空提交 | 正常解析 | no_changes，不调用空规则集合 |

这些语义由本机真实 Git 与固定 OCR v1.12.9 验证；参考 [Git diff](https://git-scm.com/docs/git-diff)、[merge-base](https://git-scm.com/docs/git-merge-base) 及固定 OCR [diff provider](https://github.com/alibaba/open-code-review/blob/bccbc15f785269400735d5255540c231e6c02b6d/internal/diff/git.go)。多祖先/无共同历史属于 Iteroom 在调用 OCR 前的拒绝证据，没有声称 OCR 对这些输入也完成审查。

## 实际 CLI 与覆盖

[匿名报告](ocr-review-input-report.json)保存 8 组实际 CLI 场景、5 组调用前拒绝；共 23 次无模型 CLI 调用。报告只投影合成文件元数据、内容/diff/规则哈希和覆盖状态，不保存正文、diff 文本、规则正文或本机路径。探针创建的仓库在 finally 中清理。

| 场景 | 核验结果 |
|---|---|
| workspace / commit | 新增、删除、重命名和测试变更与捕获清单匹配；删除有旧侧内容与 diff |
| divergent-range | merge-base 为共同祖先，from-only 文件未进入 to 的审查范围 |
| root-commit | 5 个初始文件全部作为新增；vendor 排除、测试 include 可见 |
| merge-commit | 只报告第一父比较下的一个新增文件 |
| empty-workspace / empty-commit | 零项清单、no_changes，规则请求明确跳过 |
| binary-and-unicode | 二进制精确字节哈希且被排除；中文及方括号路径按字面定位 |

覆盖记录不是推理完成记录：

- 普通可审查文件和显式 include 的测试文件为 `pending_inference`。
- OCR 默认排除的文本删除项由 Iteroom 加入 `iteroom-deletion-context`，使用 old side 取得内容/规则，也只标记 pending_inference；并未调用模型审查。
- vendor/binary 等排除项保留 reason，不向模型提供二进制乱码。
- 作用域不符、超限、staged symlink、多最佳 merge-base、无共同历史在 Delegate 前拒绝；另外的单元/本机文件测试验证实际 Windows junction、外部 gitdir 指针及持续文件改动。

## 检查与复验

新增 review-input **20/20**，与原有 R0 合计 **55/55**；现有产品测试 19 通过/1 Windows executable-bit 场景跳过，类型检查/构建通过。真实 CLI 用例只有配置已校验的二进制才运行。固定版本、下载命令和 SHA256 见 [OCR-DELEGATE](OCR-DELEGATE.md)。

```powershell
$env:ITEROOM_OCR_BIN = '已校验 v1.12.9 Windows amd64 可执行文件的绝对路径'
node --test test/r0-dsh-contract.test.js test/r0-dsh-loop.test.js test/r0-ocr-delegate.test.js test/r0-review-input.test.js
node scripts/r0/ocr-review-input.mjs
npm.cmd run check
npm.cmd test
npm.cmd run build
```

未配置二进制时真实 OCR 集成用例跳过，探针为 unavailable/退出非零；不使用 mock 替代。检查的实际通过数和平台跳过写入 [STATUS](../STATUS.md)。DSH 模拟模型证据与 OCR 实际 CLI、本机 Git/文件证据分别记录。

后续切片已从[固定副本](FIXED-REVIEW-COPY.md)实际调用 Delegate，并核对无 HEAD 和 attributes/filters 边界；[实际 OpenSandbox 子集](SANDBOX-RUNTIME.md)也已有证据。正式权限、原子快照、模型发现、UI 审查接线、其他平台和发行仍未完成；不提前迁移 R1/R2，不把 no_changes 或零发现当正确性证明。
