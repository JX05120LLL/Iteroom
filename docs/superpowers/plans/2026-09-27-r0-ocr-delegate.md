# R0 OCR Delegate Implementation Plan

> 本轮按用户明确要求在当前会话实施；保留原 UI/启动器，不提交本轮改动。

**Goal:** 用固定 OCR v1.12.9 官方 Windows x64 CLI 验证 Delegate 的三种合成 Git 输入和严格 JSON 契约。

**Architecture:** 独立 R0 进程执行器限制环境、时间和合并输出；契约解析器比对独立 Git 清单及模式/修订，不将 CLI 退出成功当覆盖完整。探针只创建一次性合成仓库，记录匿名摘要和规则哈希，不接产品流程。

**Tech Stack:** Node 原生模块、node:test、Git、官方 OCR 二进制；不新增 npm 依赖。

**Spec:** [接续要求](../../NEXT_SESSION_PROMPT.md)、[Gate B](../../ROADMAP.md)。

## Constraints and review focus

- 不调用模型、不发送用户源码、不部署沙箱；工具下载到项目外并核对发布校验和。
- 不接受越界、重复、不完整文件/规则清单；删除文件和重命名旧侧由 Git 定位，不能要求旧侧存在于当前工作树。
- 环境不继承模型、Git 注入、代理或用户 OCR 配置；HOME/USERPROFILE 指向受管目录。
- 超时/输出超限停止自己启动的进程树；进程/规则失败、异常 JSON、版本失配均不显示通过。
- 测试文件的默认排除与显式 include 分开验证；同规则分组不称语义分组。

## Steps

- [x] 编写并运行红测试：路径/模式/版本/计数/规则完整性，真实合成子进程失败、超时、stdout+stderr 限额。
- [x] 实现 `runBounded(command, args, options)` 与 `parsePreview(text, context)` / `parseRules(text, expectedPaths)`，测试转绿。
- [x] 实现 `inspectOcrDelegate(executable)`：校验固定二进制、三种 Git 输入、默认排除、显式测试 include、真实规则错误和 Git 覆盖比对；真实 CLI 单独可选集成测试，不可用明确跳过。
- [x] 运行现有/R0 测试、类型检查、构建、文档链接和 diff 检查；保存合成匿名报告并同步所有状态文档。

## Execution evidence

新增模块缺失时测试红，补充 Windows 歧义字符时路径测试再次红，实现后转绿。真实 CLI 18/18；R0 总计 35/35，现有 19 通过/1 平台跳过，类型检查/构建通过。超限子进程曾自然退出导致 taskkill 无法确认收束，保留保守 termination_unconfirmed 语义；测试改为持续活动进程核验超限停止。Gate B 不因本切片通过而完成，旧侧完整 diff、复杂分支和产品接线继续待验收。

最终自行审查补充绝对 repository 约束及空/NUL argv 拒绝；相关用例与全部 35 项复验通过。文档 18 份/75 个本地链接、围栏及匿名报告检查无错误，git diff --check 通过。无真实模型调用、用户源码外发或沙箱部署；本轮改动未提交/推送。额外探索临时目录清理遭自动策略拒绝，保持原地，不绕过；正式探针自身临时清理成功。
