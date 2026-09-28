# R0 模型请求计数的私有磁盘验证

2026-09-27。在已有 [请求守卫](MODEL-TRANSPORT.md) 的 commit/state 接口上加入独立本机文件记录。模型提供方已由用户指定为 deepseek-official / https://api.deepseek.com / deepseek-flash，Key 由用户要求保存到项目外配置；本切片不读取该文件或 Key，不发送真实请求。费用上限与真实调用授权待回复。

## 实现与范围

`scripts/r0/model-budget-journal.mjs` 导出 `openModelBudgetJournal({root, identity})`，返回 `state`、`commit(next)` 和 `close()`。仅接受 temp 根下前缀 `iteroom-r0-model-budget-` 的已有普通目录，拒绝 junction；不接受任意项目路径。用于受管 R0 实验，不是产品预算存储。

- `budget.json` 只保存请求形状 identity 与 attempts（0–6），不存 Key、正文、header、提供方响应。
- 整个探针持有 `budget.lock` 的 wx 独占锁；第二个 Node 进程不能共用。正常结束才关闭/释放本次锁，残留或替换锁保守拒绝，不自动解锁或重放。
- 每次 commit 必须是相同 identity 的连续 +1，串行排队；普通单链接记录、字节限额及 JSON/schema 校验，不覆盖链接/异常记录。
- 独占临时文件写入、flush、rename 后 commit 才返回，之后 guard 才能触达 transport；失败不返还计数，写失败后拒绝后续发送。读取旧计数后，耗尽预算仍拒绝。

这只证明受管本机目录中普通文件及不同进程的行为。Windows 目录 fsync/断电持久性、恶意同权限进程/文件竞态、自动处理残留锁、模型执行中崩溃及产品预算存储未验证。持锁覆盖整个真实探针仍需接线，费用上限不能从次数推导。未知锁/记录不能为了重新开始而删除。

## 当前验证

`test/r0-model-budget-journal.test.js` **7/7**（5 个实际本机文件/边界测试 + 1 锁初始化 I/O 故障注入 + 1 独立 Node 进程综合探针）；与模型守卫/回环 adapter 的 8 项同时运行 **15/15**，不是全部 R0。

[匿名报告](model-journal-report.json)：实际不同 Node 进程竞争锁；子进程预留并读取磁盘后触达仅抛错误的合成 transport，关闭后父进程读取 1 次计数，重启拒绝再发；另一子进程预留后直接退出留下锁，父进程拒绝自动回收。只有本次合成 fixture 在结束后清理，不含用户资源或私有配置。**actualHttp=false / actualModel=false**。

新增测试也实际将自己的记录文件替换为目录导致写入失败，核对发送次数为 0；junction、异常 JSON/identity/计数及非连续 commit 拒绝。上述目录替换是实际本机文件故障，不是断电或真实模型故障注入。另一个回归向真实文件写入部分内容后注入ENOSPC，证明初始化失败时句柄关闭、未知锁保留且原始错误不被清理错误覆盖；不是实际磁盘满。

## 复验与后续

```powershell
node --test test/r0-model-budget-journal.test.js test/r0-model-request-guard.test.js
node scripts/r0/model-journal-probe.mjs
```

无需模型凭证/服务或沙箱。真实探针取得明确调用/费用授权后，使用该计数接口、固定官方 adapter 和独立 DSH_HOME；先落实金额约束再运行 Gate A 真实循环。不要使用旧 Web 入口发送合成 Gate 请求，以免启用完整宿主工具或扩大数据范围。Gate A/R0/v1 保持未完成。

官方公共资料：截至 2026-09-27，[模型与价格](https://api-docs.deepseek.com/quick_start/pricing/)列有 deepseek-flash 与工具调用支持、峰谷 token 计价；[发布说明](https://api-docs.deepseek.com/zh-cn/news/news260910/)说明模型名对应 V4.1 Flash。不是本项目 API 实测，不能从文档断言当前 Key/余额/路由可用；真实执行前重新核对价格和用户上限。

后续状态：2026-09-28 已按另行授权完成[真实模型/DSH/沙箱组合](DSH-LIVE.md)。上述“真实探针尚待接线”的表述是本切片的历史状态，私有磁盘计数现已接入该次受管 R0 探针；它仍不是产品预算存储或提供方硬限额。
