# R4：审查准备与后续推理

最新切片：[R4-3 计划](FIX-PLAN.md)与[关联修复证据](FIX-EVIDENCE.md)。下文保留 R4-1 原计划；R4-2/R4-3 已接线，真实审查模型与实际沙箱组合闭环、完整 R4 尚未验收。

本轮交付 R4-1：把固定 OCR Delegate 从 R0 探针接入受管产品入口。后续 R4-2 接审查推理与发现定位，R4-3 接关联修复；R4 不因准备完成而验收通过。保留 R3 未提交并发修复与现有开发入口。

## 输入与边界

- 接受工作树、单提交、提交范围；历史模式只接受完整 40 位 SHA-1，范围使用唯一 merge-base，合并提交比较第一父、根提交比较空树。
- 产品任务新增 `review`，仍采用版本 1 任务记录，可选 `reviewInput`、`reviewSnapshotId`、`reviewFailureCode` 与 `reviewCleanupPending` 字段，R1/R2/R3 旧记录不迁移。准备完成保持 queued/not_started，直到后续审查启动或用户放弃；不伪造 DSH Session 或模型执行。新程序读取旧记录，旧程序不认识 review kind，回退前备份项目外数据。
- 从当前启动项目只读采集，受限 Git 操作禁用 hooks、外部 diff、textconv 与用户环境；在独立临时仓库重建 objects/index/工作树后才运行 OCR，前后复核输入。普通 remote/user/branch 配置可接受，filters/includes/attributes、外部 Git 存储、子模块、链接、超限和不支持编码拒绝。
- 沿用 100 文件、单文件 256 KiB、旧新侧合计 1 MiB、Git 对象 1000 个/16 MiB 的保守上限；不是 OS 原子快照或大仓库支持。临时副本只用于准备并收束，持久化仅保存限定变更、规则和覆盖；敏感路径、provider/二进制等排除项不保存正文。
- 固定 OCR Windows x64 v1.12.9 / bccbc15f 与二进制 SHA256，凭启动环境 `ITEROOM_OCR_BIN` 指向项目外文件；不自动下载、升级或另起完整 OCR 推理 Agent。
- 测试源码默认排除需显式补充，删除保留旧侧规则与原因，重命名保留旧新路径；覆盖统一为 pending_inference/excluded，不以无发现当已审查。

## 接口

`POST /api/iteroom/managed-tasks/review/prepare`：同源、认证载体、8 KiB JSON；精确输入 `{requestId,input:{mode,commit?,from?,to?}}`。相同请求复用已固定记录，不重新采集变动后的源码；不同输入复用 requestId 拒绝。准备期间同请求合并，单项目任务位阻止其他任务。

`GET .../review/preparation?taskId=...`：核对记录/关联/hash，返回固定的变更侧、Diff、覆盖和带哈希的 OCR 规则；数据在项目外 `managed-reviews-v1`。损坏拒绝读取，不回退工作树。

`POST .../review/cancel`：精确 `{taskId,requestId}`，等待本次准备收束后放弃 queued 任务；不写项目，不调用模型。已放弃记录可经原历史删除动作删除，受管删除增加 review 快照目录。活动准备不允许删除。终止/清理未确认则持久化阻塞，重启、取消与再次准备均不自动释放或重放；当前没有自动解除动作，须人工核对。

UI 新增“变更审查”面板，提供三种输入、固定输入预览、覆盖/排除原因和 Diff，显示“已固定 · 尚未推理”。审查执行入口在 R4-2 接线前禁用并说明；保留方案 C、旧理解/修改/通话入口。

## 实施与验证

1. 将已验证的 Git/输入/副本、OCR JSON 与进程边界提升到 `src/host/review/`；R0 文件保留兼容导出并回归原测试。
2. 在 ManagedTaskStore 增加严格 review 输入、关联和放弃；实现 ManagedReviewCoordinator 与 hash 绑定持久记录，补去重、重启、损坏、失败、串行、清理和敏感内容排除测试。
3. 添加同源受管路由和真实 API 面板，检查跨来源、超限、额外字段与任务范围；用一次性合成 Git 仓库分别实际运行三种模式的 OCR CLI，验证源 HEAD/index/文件未变。
4. 执行专项/R0/全量测试、类型检查、构建、Web smoke、包清单；浏览器实际准备工作树并验证三种模式表单、固定 Diff、放弃、删除和移动布局，三种模式真实执行另由 CLI 集成验证，保存匿名证据并同步文档。

复验命令与实际计数记录在 EVIDENCE.md；所有未启用的实际 CLI 检查明确标跳过。真实模型请求为 0，不提交或推送。真实用户仓库、多 Host 互斥、原子采集、审查推理与修复复查仍待后续验收。

## 后续切片

- R4-2：为已固定 review 输入启动原 DSH Loop，定义审查工具/输出 schema、分组与持久预算。逐文件保留 pending/completed/failed/excluded，结构化发现必须关联准备 hash 与变更侧；唯一片段定位后才显示行号。先合成模型验证失败、零发现、部分覆盖、取消和重启不重放，再在新授权内真实模型复验。
- R4-3：用户选择已定位发现创建关联 modify 任务，保留 finding/preparation 关系；使用 R2 沙箱和 R3 接受，修复后固定新输入复查，不能复用旧结果冒充新证据。需要新/删/重命名补丁的场景仍等待补丁类型扩展。
