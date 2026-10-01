# 下一轮接续提示

请继续 D:\code\Iteroom，从 docs/r4/FIX-PLAN.md、FIX-EVIDENCE.md、DELIVERY-2026-10-01.md、delivery-2026-10-01-report.json 与 docs/STATUS.md 第 29–30 节接续。先核对 Git 工作区、HEAD/远程、服务和可用授权，保留已有改动。R3 修复、R4-1/R4-2/R4-3 及 README 流程图已纳入本次远程交付，从当前 main 接续；父基线为 3d21332，最新提交以实时 Git 检查为准。历史报告中的未提交/未推送字段是报告生成时的状态。不自动追加 commit/push/publish。阅读 AGENTS、README、CONTEXT、PRD、ARCHITECTURE、ROADMAP、STATUS、ACCEPTANCE 与相关实现/测试。

R0/R1/R2/R3 仅在各自固定环境、合成输入和选定现有文本文件范围有证据。旧完整 DSH Web 入口仍含宿主工具；方案 C 白色 UI、双拱门 Logo、禁用通话预览和旧开发入口保留。不要另建 Loop 或提前扩展语音/RAG/分布式调度。

R4-1 的真实官方 OCR v1.12.9 三种输入与固定规则/覆盖已接产品。R4-2 原 sdk-minimal Loop 仅注册固定组读取工具；完整上下文每组 8 KiB、总 16 KiB/两组，4 请求/512 输出 tokens，超限保持待审；严格 JSON、实际组读取、固定侧唯一 quote 定位、结果收据、取消与重启不重放已验。原始报告与 Hash 是历史证据，新源码以 fix-report 为准。

R4-3 新 ManagedReviewFix 协调用户选择已定位 new 侧 modified 普通源文件→显式目标/测试范围→固定关联 modify→沿用 R2/R3→接受后新工作树 review。reviewOrigin 绑定审查/准备/报告/发现/路径/源码 Hash；recheckOrigin 绑定 modify/产物。普通公开 create 不能注入关系，Store 同锁内阻止父删除，旧记录仍可读。旧程序缺新关系保护，回退前备份项目外数据。关联创建不执行模型；准备取消/开始/历史删除路由须 await whenPrepared 收束。新增回归复现并修复取消提前完成后发布快照的竞态。跨 Host 和底层快照助手直接并发删除不归入已验证保证。

复查只在 accepted 关联任务、源码/固定测试匹配产物后准备当前工作树全部变更，持久化前后核对固定新侧。目标恢复成 Git 无变更暂返回 REVIEW_RECHECK_TARGET_MISSING，不能把 no_changes/零发现/旧报告当作修复通过。UI 可以跳到关联任务、返回来源和新准备；推理仍由用户显式开始，没有自动将原候选标成已证实修复。

本轮新增 11 项（包含两项真实 OCR）纳入全量；116 项/115 通过/1 Windows 条件跳过。真实浏览器 390×844 通过关联创建、来源/刷新/父删除保护、真实 R3 接受、新准备与新报告、同目标往返；两个审查都经真实 OCR/原 DSH CLI 配本地 mock，原候选 1、新候选 0。修改执行/候选由合成收据注入，actual sandbox=false，真实请求/用户源码传输=0。check/build/test:web/包清单与文档检查详见 fix-report。没有实际沙箱组合闭环、真实模型质量或完整 R4/v1 验收。

下一切片先无模型验证原 DSH mock 修改工具→实际 OpenSandbox→固定测试/补丁→R3 用户接受→新快照复查组合链路。参考 docs/r2/EVIDENCE.md 与既有合成验证授权，先核对回环 3088 控制服务/Linux Docker；本轮结束前没有该服务可用的证据，不把旧报告当实时状态。仅使用一次性合成代码，不挂载用户源码，不修改其他服务配置或清理既有容器。服务/SDK/镜像按原固定版本，在独立目录启动自己的资源并验证归属清理。

真实 DeepSeek 无剩余授权额度，旧 R2 4 次已用完；新调用必须另说明请求次数、tokens、人民币上限和仅合成传输并获授权。无模型进度继续独立推进，不以 mock 外推真实模型。

无变更目标复查、新/删/重命名补丁、原问题修复判定、cleanupPending 显式解除、完整 DSH 历史清除、真实崩溃/多 Host、原子输入、用户项目和干净发行另验。Windows 元数据 rename 仅同临时替换有限重试（6 次/375 ms），源码写回/模型额度/快照不盲目共用策略。结束保存匿名证据、同步 PRD/架构/路线/STATUS/README，分别说明离线、真实 CLI、mock、浏览器、实际沙箱、真实模型及未验边界。
