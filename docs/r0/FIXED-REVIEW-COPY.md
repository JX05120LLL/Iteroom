# R0 Gate B：固定输入副本与收口

2026-09-27。此页在 [Delegate](OCR-DELEGATE.md) 与 [输入捕获](REVIEW-INPUT.md) 的实际证据上收口 Gate B。仅验证 Windows x64、OCR v1.12.9、一次性受管合成仓库；不表示正式审查、恶意仓库快照或 v1 验收完成。

`createFixedReviewCopy(fixture, input)` 返回独立 fixture、冻结 record、`verify()` 和 `dispose()`。对象按类型、原始内容及 SHA-1 逐个核验后重建为独立 loose objects；不 clone/checkout，不复制配置，不共享 objects、alternates 或硬链接。索引和工作树按捕获的模式与字节重建。源在副本完成后被修改或删除，OCR 仍读取副本；每次 Delegate 前后核对 inputSha256。

Git 前置检查拒绝外部对象存储、目录链接、硬链接、非普通元数据、未允许的本地配置和 attributes。过滤器、外部 diff、include、fsmonitor 不会作为用户配置执行；受控环境禁用系统 attributes。历史、工作树和忽略的路径祖先中的 `.gitattributes` 也拒绝。这是保守的不支持边界，不能标成对任意 Git 仓库兼容。

无 HEAD 输入使用空树；固定版 OCR 会回退 staged diff，因此仅接受 staged 内容与当前文件一致的新增，再加未跟踪新增。未暂存的分歧在 Delegate 前返回 `unborn_unstaged_input`，不偷偷创建用户提交。BOM、CRLF、binary 和 index mode 保留。对象复制默认最多 1000 个、单对象 1 MiB、总计 16 MiB；输入预算沿用输入捕获模块。

## Gate B 逐项证据

| 要求 | 实际证据 |
|---|---|
| 固定版本/真实 CLI 与 JSON | 官方 v1.12.9 Windows amd64、SHA256 与 version 校验；字符串 schema_version、路径/统计/规则校验，见 Delegate 报告 |
| 工作树/单提交/范围 | 原 Delegate 三模式；输入扩展分叉/root/merge/空输入；本轮六组固定副本及无 HEAD 实际 CLI |
| 旧/新侧和变更覆盖 | Git blob、完整 diff、新增/删除/重命名；测试显式 include；文本删除通过 old side 待审，binary/provider 排除理由保留 |
| 对应固定输入 | 源修改后独立副本运行 preview/rule，CLI 前后哈希一致；副本变更被拒绝 |
| 路径/进程/超时/异常 JSON/输出限额 | 既有契约与实际子进程测试；实际 Windows junction、Git 链接、外部 gitdir/objects、attributes/filter 拒绝；超时进程树停止核对 |

[新匿名报告](ocr-fixed-input-report.json)为 20 次实际 CLI 调用、六组场景、无 HEAD 场景及三类调用前拒绝；仅包含合成元数据与内容/diff/规则哈希。旧报告保留各切片当时的未完成状态，最新 Gate B 以此页和 STATUS 为准。

本轮 fixed-copy 测试 11/11，连同既有 R0 为 66/66（含三组真实 OCR 集成）。Gate B 在上述限定平台与输入边界内通过。副本文件仍是普通可写文件，前后核对不是操作系统只读保护；多次捕获不是原子快照，不能防御所有瞬时改动后恢复的竞态。真实项目权限与快照、审查推理/问题定位、UI 接线及其他平台留在后续阶段。

## 复验

```powershell
$env:ITEROOM_OCR_BIN = '已校验 v1.12.9 Windows amd64 文件的绝对路径'
node --test test/r0-dsh-contract.test.js test/r0-dsh-loop.test.js test/r0-ocr-delegate.test.js test/r0-review-input.test.js test/r0-fixed-review-copy.test.js
node scripts/r0/ocr-fixed-input.mjs
```

固定工具的来源/安装命令见 [OCR-DELEGATE](OCR-DELEGATE.md)。工具不可用时返回 unavailable，真实集成测试跳过不算通过。Gate A/C 仍有真实缺项，不迁移 R1/R2，不提交或推送。
