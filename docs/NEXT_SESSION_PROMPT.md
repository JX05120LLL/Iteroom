# 下一轮接续提示

2026-10-09 最新接续（优先于下文 R5-1 历史说明）：`daafd60` 的 R5-1 已推送，R5-2 本轮得到开发和推送授权，最终交付提交须重新查 Git。先核对工作区、HEAD/远程及所属服务，保留已有改动；读取 AGENTS/README/CONTEXT/PRD/ARCHITECTURE/ROADMAP/STATUS/ACCEPTANCE，以及 [安装证据](r5/INSTALLATION-EVIDENCE.md)、[支持矩阵](r5/SUPPORT-MATRIX.md)、[交付报告](r5/installation-delivery-2026-10-09-report.json)、[安装最终报告](r5/installation-final-2026-10-09-report.json)和[异常收尾报告](r5/installation-fault-2026-10-09-report.json)。报告 parent 为验证父基线，不能冒充最终提交 Hash。

R5-2 在仓库外实际安装 tarball/生产依赖并运行已安装 Node launcher 与 Chromium 页面，未链接 checkout node_modules；只验证认证、缺配置、任务取消和收尾，使用本机 npm 缓存，不是空缓存/全新机器/已安装真实模型沙箱完整流程。新理解取消状态仍为 v1，旧程序可能不认识；降级前停止服务、备份完整项目外数据，优先保留并恢复升级前备份，不批量删除用户历史。相关 starting/cancelling 门闩、等待快照/claim/engine 收束和历史锁内串行保护不能移除。

本轮真实模型/实际沙箱/用户源码传输均 0，当前 R5 和完整 P0/v1 未完成。下一项：先定义新增/删除/重命名补丁的版本化快照、工具、导出、接受恢复协议与实施计划；离线测试覆盖拒绝、冲突、部分失败、恢复和旧格式，再接实际沙箱。未支持路径保持拒绝，不仅扩大 Diff 显示或沿用审查覆盖来宣称修改支持。保留方案 C 白色/Logo/禁用通话及旧开发入口，无第二套 Loop。

复验使用证据文档命令，工具采用已核对的项目外固定 OCR 与 Playwright；安装默认离线、缓存缺包保持失败，允许下载公共依赖时才加 --online。分别记录 mock/实际 CLI/生产浏览器/模型/沙箱；每轮新的真实模型费用授权独立核对，旧 R4 额度不自动继承。后续 commit/push 仍需当轮授权。本轮旧 R5-1 说明保留如下，其“下一步安装”已由以上 R5-2 接续取代。

请继续 D:\code\Iteroom。先核对 Git 工作区、HEAD/远程和服务，保留已有改动。R5-1 交付父基线为 main / 1fbaa41；2026-10-09 用户授权提交推送及继续开发，实际交付 Hash 以实时 Git 为准，历史报告字段保留生成时含义。未公开发布 npm。阅读 AGENTS、README、CONTEXT、PRD、ARCHITECTURE、ROADMAP、STATUS、ACCEPTANCE，以及 docs/r5/PLAN.md、EVIDENCE.md、delivery-2026-10-09-report.json、delivery-2026-10-09-browser-report.json 与相关实现/测试。

R0–R4 最小阶段退出在固定 Windows/版本/合成现有文本范围通过，不是完整 P0/A01–A21/v1。保留方案 C 白色 UI、双拱门 Logo、独立禁用通话预览、旧完整 DSH Web 开发入口及其原宿主工具边界。不要另建 Agent Loop，或接语音/RAG/记忆/分布式调度。

R5-1 新增认证配置/预算 GET 与显式同源沙箱检查 POST，仅读既有配置，仅固定本机 GET 单页查询，不创建沙箱或启动任务。请求与完整 body 共享 deadline/64 KiB 限额，reader cancel 和 SDK close 后才解除重复探测记录。missing/invalid/configured 分开，账户未验证、可连接不等于镜像执行就绪、请求上限不等于费用硬限额。旧数据格式/API 保持兼容，不提供配置编辑。

最终新鲜验证：runtime 12 项，相关19/19；全量132项、131通过、1 Windows执行位条件跳过、0失败；check/build/test:web 和390×844生产UI/真实SDK配本机合成HTTP通过。合成仓库6文件Hash及HEAD/index/status不变，模型请求/实际沙箱分配0。当前源码/构建/探针Hash在交付报告中；10-05旧浏览器报告早于清理重入修正，不替代最新证据。

旧 Temp OCR 可执行文件已缺失，恢复固定官方 v1.12.9/bccbc15f 到项目外稳定安装目录。ITEROOM_OCR_BIN 必须指向经核对的工具：%LOCALAPPDATA%\Iteroom\tools\ocr\v1.12.9\opencodereview-windows-amd64.exe，SHA256 ae6f4785fea34a5cfef93ad22d8e7fb8032bbd12c45f2cbcc98cbe1b38cceff1。不要将私有凭证、路径日志或二进制加入仓库；缺工具的mock/跳过不算实际CLI验证。

下一步先完成 R5 的仓库外 tarball 安装/启动切片：新临时消费目录、仅生产依赖、无本仓库node_modules链接、临时数据/合成Git项目，验证已安装入口、静态UI、运行状态认证和缺配置失败关闭，最后确认所属进程/端口收束。使用已有依赖缓存时标明缓存条件，不称全新机器的干净安装或全平台发行验收；不调用模型/实际沙箱。之后继续：

1. P0-07/A05：新增/删除/重命名补丁的快照、工具、导出、冲突、接受与恢复协议。R4 可审查这些类型不表示 R2/R3 已支持修改。
2. 权限/预算配置与故障恢复：批准作用域明确、拒绝无副作用、失败不回退宿主。
3. 数据管理：cleanupPending 显式核对解除、完整 DSH 历史清除/导出、无变更目标复查、兼容备份/回退。
4. 支持矩阵和三个完整演示；真实用户项目、跨Host/编辑器原子性、真实断电和其他平台仍未验。

旧 R4 12次/512输出tokens/5元授权预留8次，余4次不跨R5自动使用。真实模型需新的次数/tokens/费用和仅合成传输授权；只使用既有项目外配置，不输出或复制凭证。既有无模型沙箱授权按原范围，复测前重新核对Docker Linux API/安装根/服务，不挂载用户源码、不清理他人容器。本切片不启动实际沙箱服务。

保存匿名证据并同步核心文档。提交/推送须用户当次授权；本次已授权交付不等于今后每轮自动提交。不可将局部验证称 R5 或 v1 已完成。
