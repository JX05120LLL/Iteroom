# R0 Review Input Implementation Plan

**Goal:** 在已有合成 OCR 探针上补足可定位的旧/新侧、完整 Git diff 及分叉/空输入/二进制/链接边界。

**Architecture:** `captureReviewInput(fixture, input, limits)` 仅接受项目外受管 R0 仓库；历史侧读取 Git blob，工作树侧限定普通文件并核对读取前后状态。返回字符串内容与哈希，不把可变目录当产品快照。独立扩展探针与固定 OCR 逐项核对，不改变产品入口。

**Tech Stack:** Node 原生文件/进程模块、Git、node:test、已校验 OCR v1.12.9；无新依赖。

**Spec:** [PRD](../../PRD.md)、[接续要求](../../NEXT_SESSION_PROMPT.md)。本轮按用户要求在当前会话继续实施，不提交/推送。

## 接口与验收

- 进程执行器可选择保留 stdout 原始字节，明确允许 Git no-index 的退出 1；默认仍只接受退出 0。
- 输入记录包含 mode、resolvedBase/resolvedTarget/mergeBase、旧/新 path/mode/blob/contentSha256、完整 per-file diff/hash 和 input hash；文本使用不可变字符串，公开报告仅投影元数据。
- range 对比唯一 merge-base 到目标；merge commit 使用 first parent；root commit 对空树；空输入为 no_changes 且不请求空规则集合。
- 新增/删除/重命名旧侧存在明确状态；binary 保留字节哈希、禁止当文本审查；链接、gitlink、路径越界、大小超限、来源改变直接失败。
- 测试源码显式纳入；删除建立旧侧待审范围，即使 OCR 默认排除也不冒充已完成审查；provider/binary 排除可见。
- 无模型/源码外发/沙箱部署，不修改用户仓库，不接 R1/R2。

## Steps

- [x] 新增旧/新侧、固定历史、分叉、root/merge、空输入、binary、链接/路径/预算测试并观察失败。
- [x] 最小扩展进程与 Git 辅助接口，实现受管输入捕获；运行测试。
- [x] 扩展独立真实 OCR 探针，保存匿名证据，对删除/测试覆盖给出准确状态。
- [x] 运行全部 R0、现有测试、类型/构建/链接检查，自行 review 并同步文档。

## Review focus

文字解码不能损坏二进制哈希；历史读取不能使用当前工作树；range 不能误用两端直接差异；链接不能解引用；公开报告不得泄露原内容或临时路径。工作树捕获前后核对不是对抗并发的原子快照，产品正式快照接入另验收。

## 本轮证据

初次缺模块/字节退出码测试失败，实现后通过。BOM 原文丢失和外部 gitdir 指针缺少约束由红测试发现，修复并复验。最终 review-input 20/20、R0 共 55/55，现有 19 通过/1 平台跳过；类型检查和构建通过。真实 OCR 8 组场景/23 次无模型调用，5 组调用前拒绝；删除/测试保持 pending_inference，不声称完整审查。报告与实现均未提交。

最终自行 review 与文档验证完成：20 份 Markdown/91 个本地链接、代码围栏、报告隐私/结果和新增文件空白检查无错误，git diff --check 通过。Gate B 的固定副本接线仍缺，不把前后核对表述为原子快照。
