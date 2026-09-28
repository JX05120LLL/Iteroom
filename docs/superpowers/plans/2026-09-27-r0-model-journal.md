# R0 模型请求私有磁盘记录

目标：给已有 fetch guard 的 commit/state 接口补实际文件和进程证据，防止退出后丢失已预留请求次数。仍不调用真实模型，不读取 Key，不更换产品入口。

范围：独立 scripts/r0/model-budget-journal.mjs，只接受项目外 temp 根下 前缀 iteroom-r0-model-budget- 的受管实验目录。保存 identity/attempts，不存凭证、正文或提供方响应。一次整个探针持有 wx 独占锁，残留锁保守拒绝，不自动解锁/重放。文件 flush + rename；不声明 Windows 断电持久性或生产预算存储。

- [x] 测试先失败：磁盘提交先于 transport、不同进程重开不返还、并发锁、残留锁、异常记录/identity/序号、junction 路径及实际写失败。
- [x] 最小实现 openModelBudgetJournal({root, identity}) 返回 state/commit/close；guard 接口不变。先校验后锁，首次计数初始化在独占锁内；失败保留计数/锁直到显式关闭，不删除未知记录。
- [x] 本机独立 Node 子进程只执行合成 transport 失败，父进程读取磁盘记录并验证预算耗尽；匿名报告只含检查和次数，不含 temp 路径/进程 ID。
- [x] 相关测试、类型/旧测试/构建、一次独立最终审查、文档/匿名证据同步。费用上限与真实请求授权仍待回复；官方价格是核对事实，不是实现金额拦截。

用户已要求持续完成 R0；本切片属于已有模型传输准备的本机验证，不追加阶段、真实调用或提交权限。方案与最小改动由当前会话执行。

审查记录：0 Critical / 1 Important / 0 Minor。锁初始化部分写失败会泄漏handle；回归先失败（fd仍为3），修正finally关闭handle后通过（fd=-1），保留未知锁和原始ENOSPC。该I/O错误是注入，文件和句柄实际核对；不是实盘耗尽。仅一次修正、无二次审查。最终7 journal + 8 guard =15/15，类型/旧产品19通过1平台跳过/构建通过；34 Markdown、203本地链接、16匿名报告与隐私/语法/空白检查通过。没有commit/push、模型HTTP或新增沙箱。
