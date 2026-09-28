# Iteroom 当前状态

> 2026-09-26 的重规划快照保留在下文早期章节；最新功能进度见本页顶部及末节。各节中的提交状态为当时记录，当前 Git 状态需实时核对。

2026-09-28 最新更新：R0 技术兼容验证已在固定环境和合成输入范围内完成并推送。R1 已接[受管任务登记](r1/TASK-ENTRY.md)、[受限读取](r1/READ-SCOPE.md)、[固定输入](r1/INPUT-SNAPSHOT.md)、独立只读 DSH 引擎及方案 C 文字 UI；[第三轮受管真实模型任务](r1/READONLY-LIVE.md)在 Windows/新合成仓库完成准确回答和可点击引用，重启后未重发，R1 受管只读退出条件在声明范围通过。旧完整 DSH Web 开发入口保留；独立发行 Host、OCR/沙箱产品接线、补丁接受与 v1 发行验收未完成。见末节；前文各节是历史切片记录。

## 1. 代码事实

| 范围 | 源码情况 | 验证边界 |
|---|---|---|
| 本地启动 | `bin/iteroom.mjs` 启动固定 `dsh --profile web`，绑定 127.0.0.1 | 仍是全量 DSH Web，不是新自有 Host |
| 依赖 | package.json 固定 DSH 0.1.5-rc.3，配套 Cordis 包本地为 4.0.2 | 尚未收敛为最小发行组合 |
| 任务审阅 | `src/index.js` 读取 Session 事件，提供 project/tasks 只读接口 | 当前投影状态不能代表目标产品状态机已实现 |
| R1 受管任务 | 版本化 JSON、已认证 API、单任务状态/事件游标和独立 DSH Session | 第三轮真实理解成功，重启前后请求均为 2；仅 Windows/合成文本范围 |
| R1 受限读取与固定输入 | 选定文件读取、项目外 SHA-256 副本和清单、唯一 DSH 只读工具 | 实际第 1 行引用准确；应用层哈希复读，多文件非原子 |
| Git 证据 | `src/host/` 保存任务前后 Git 可见文件净变化和部分前台检查结果 | 外部编辑可能混入，不证明每行由 Agent 修改 |
| UI | 白色方案 C、双拱门 Logo、受管代码理解、旧文字工作台与独立通话预览 | 浏览器完成态和来源定位通过；真实生成中间帧未捕获，语音禁用，旧 DSH 会话仍有宿主工具 |
| 测试 | 单元、官方 CLI 模拟循环、Web smoke 与浏览器合成任务 | 第三轮真实模型完成；真实提供方断线、其他平台和发行未验收 |
| 发行 | private 开发包，已有 build/prepack 源码 | npm 未发布，干净安装、跨平台及 R2–R5 流程未验收 |

## 2. 技术研究结果

以下为重规划时的研究状态；后续真实证据与安装变化见第 7–12 节。

- 先前 Cordis 组合检查只证明 DSH 必要插件可注册；本轮重新核对了固定版 Loop 依赖及内部工具 scheduler。生产启动、真实模型/工具、取消/恢复还需 Gate A 验证。
- OCR 已读 Delegate 源码，研究快照为 `486022d`；确认 JSON 准备接口。没有执行 OCR CLI 或真实审查。
- OpenSandbox 已读架构/SDK/执行源码，研究快照为 `4a56195`。没有部署服务、创建沙箱或验证 Windows 环境。
- 方案 C 设计与现有截图保留；设计稿里的文件、会话和字幕是示例。旧文档记录过 Windows/Node 24.14.0/Chromium UI 检查，本轮未复验。

## 3. 重规划时的目标能力状态

以下为 2026-09-26 的重规划快照；R1 受管任务/只读权限/固定输入与真实模型的最新验收见顶部及第 23 节。当时自有产品 Host/任务状态、权限策略、不可变输入快照、OCR 审查准备、沙箱执行、远端停止核对、补丁写回、冲突保护、新任务恢复及证据存储均待实施和验收。没有把文档完成视为这些功能完成。

当前 DSH 会直接通过其现有工具工作，不具备目标“仅沙箱修改”的保证。新模式未实现之前，不将当前运行版本标记为受控隔离助手。

## 4. 当前可用源码入口

需 Node.js 22.19+ 或 24+。在本仓库安装/构建后，以合成或隔离 Git 项目启动旧开发入口：

```powershell
npm.cmd install --registry=https://registry.npmjs.org
npm.cmd run build
npm.cmd start -- D:\code\your-project --no-open
```

模型配置由当前 DSH 页面承担。执行真实项目之前需要理解现有 DSH 权限和代码发送范围；当前不需要 OpenSandbox 是旧开发入口的事实，不是 v1 隔离模式无需服务。

Windows 默认数据目录为 `%LOCALAPPDATA%\Iteroom\harness`，`ITEROOM_DSH_HOME` 可隔离；启动器将产品证据置于该目录的 `iteroom` 子目录。任务开始快照可能含源码，结束时移除原始基线；异常中断可能残留。旧版本没有 UI 删除入口，清理须停止服务并备份所需历史。

现有只读接口：`GET /api/iteroom/project` 返回 `{cwd}`；`GET /api/iteroom/tasks?sessionId=...` 返回 `{tasks}`，由 DSH Connection 承载，不返回原始基线。检查状态为 passed/failed/unknown/out-of-scope；后者不算本项目验证。

## 5. 接续开发入口

阅读 [PRD](PRD.md) → [架构](ARCHITECTURE.md) → [路线](ROADMAP.md) → [验收](ACCEPTANCE.md)。R0 技术验证已在限定范围收口；下一阶段按 R1 设计自有 Host 和受管任务入口。再次发送真实模型请求前仍需核对请求类别、次数、数据范围、当前价格与新的费用授权。

更新本文件时写出实际命令、环境和结果位置；失败、mock 和未验证项分别记录。用户代码、配置与原有未提交改动不可为推进新架构而删除。

## 6. 本轮文档整理

旧 PRD/README 的整套 DSH 产品包装路线和 M0–M5 被新职责分工及 R0–R5 替代；新增架构、路线、验收、依赖归属、术语和架构决策。方案 C 源文件及现有截图保留，运行代码和测试未改动。

清理范围仅为废弃的 `docs/design-options/editorial/` 与 `instrument/`。删除执行被自动策略拒绝（仅返回 blocked by policy），两个目录仍在本地并继续被 Git 忽略，不进入文档索引或仓库交付。未删除 node_modules、lib、测试、当前源码或用户数据。

改写前的 README、AGENTS、.gitignore 与完整 docs 已备份到项目外临时目录，便于恢复未提交文档内容；备份没有进入仓库。

本轮检查：11 个有效 Markdown 文档、45 个本地链接与代码围栏检查通过，14 项 P0 都在验收矩阵中有明确关联；`git diff --check` 通过。未运行模型、沙箱、构建或行为测试；文档检查不代表产品验收通过。

## 7. 2026-09-27 · UI 收敛与 R0 第一个切片

- UI 确认为 DSH 布局主体，Ant Design 局部补充任务、权限、审阅、验证与设置。十页独立设计原型使用合成数据；正式产品未接入 Ant Design，运行代码未替换。
- 新增 `scripts/r0/dsh-contract.mjs` 与独立测试。核对固定版公开导出，并实际通过 CLI 的 Profile/Patch dump-config 合成候选配置；明确禁用默认宿主执行项。临时目录隔离且清理，不读取真实源码/凭证，不调用模型或沙箱。
- [结果与复验](r0/DSH-CONTRACT.md)及[匿名报告](r0/dsh-contract-report.json)：R0 测试 9/9 通过，`npm.cmd run check` 通过，原有测试 19 通过、1 项 Windows 文件执行位场景跳过。现有 `npm.cmd test` 未自动包含 R0 文件，需独立执行其测试命令。
- 应用真实启动、模拟/真实模型工具循环、权限执行、取消收束、Session 恢复、OCR 与实际 OpenSandbox 均未完成；R0 Gate A/B/C 保持未完成。未重新构建、运行浏览器或做发行验收。
- 本切片只添加独立工具并同步文档，没有切换原启动器、修改旧产品行为、安装依赖、提交或推送。

## 8. 2026-09-27 · R0 运行切片

- 新增 `scripts/r0/dsh-loop-probe.mjs`、独立合成插件及运行测试。真实启动官方 sdk-minimal CLI，禁用宿主执行项和真实模型适配器；模拟模型经 DSH Loop 实际调用自有内存只读工具并接收结果，临时合成工作区不变。
- 越界输入在工具正文之前拒绝；模型错误保留为 error。公开 Agent.cancel 收到 AbortSignal，并以 whenIdle 确认模拟活动收束。拒绝工具与正常结束的模型 turn 分别记录，不将 completed 当作验证通过。
- 四个 Session 历史与终态实际持久化。SDK 对已有 Session 报已存在；第三个 CLI 进程通过公开 agents.resume 恢复已结束会话，既有工具未重放。SDK 缺单任务取消/直接恢复，后续 Host 需显式提供这些产品动作。
- [运行结果与复验](r0/DSH-RUNTIME.md)、[匿名报告](r0/dsh-runtime-report.json)：新增运行测试 8/8，R0 合计 17/17；类型检查通过，现有测试 19 通过、1 项 Windows 文件执行位场景跳过。三个探针进程退出码均为 0。R0 测试仍单独执行，不宣称 npm test 已覆盖它们。
- Gate A/B/C 未完成。真实模型、自有沙箱工具、远端取消、权限审批、崩溃/未知副作用恢复、浏览器和发行未验证；本切片没有更换 UI/启动器、修改业务逻辑、安装依赖、提交或推送。

## 9. 2026-09-27 · 仓库阶段快照与接续

- 用户要求提交仓库；范围为当前启动器、旧开发版任务审阅/工作区证据、新定位文档及 R0 独立检查，并保留已选方案 C 资产。仅作本地阶段提交，不推送或发布。
- 提交前重新执行：`npm.cmd run check`、`npm.cmd test`、`node --test test/r0-dsh-contract.test.js test/r0-dsh-loop.test.js`、`npm.cmd run build`。分别为类型检查通过、19 通过/1 平台跳过、17/17 通过、构建通过；Web smoke、浏览器、真实模型、实际沙箱和发行本轮未复验。
- 检查时远程 main 为 b9e3c47，与提交前本地 HEAD 相同。当前仓库没有已跟踪的 GitHub Actions 工作流；本地新提交尚未推送，不能称作该提交的远程 CI 通过。
- 下一切片为 Gate B 的真实 OCR Delegate 合成 Git 输入/JSON 契约检查。可复制的[接续提示词](NEXT_SESSION_PROMPT.md)已保存；下一会话重新核对状态，不沿用过期的提交/服务判断。

## 10. 2026-09-27 · 远程同步与 Gate B CLI 切片

- 开始时工作区干净，本地 main 为 `778f1f1`，远程为 `b9e3c47`；按本次明确要求推送现有提交，远程 main 已核对为 `778f1f1d7ec9540ce1209d9ae2d5809c0d3f79fb`。没有新增本地提交或推送本轮开发改动。仓库无已跟踪 Actions 工作流，gh run list 无运行记录，不宣称远程 CI 通过。
- 只读检查未发现命令行标记为 Iteroom/DSH/R0 的 Node 服务；已有其他 Node 进程和监听端口保留，不停止或修改其他会话服务。
- 下载官方 OCR v1.12.9 Windows amd64，校验发布 SHA256 和实际版本，工具/源码检查留在项目外；不新增产品依赖，不接完整 OCR Agent。
- 新增独立 `ocr-process/contract/fixture/delegate` 模块及测试。一次性合成 Git 仓库真实验证 workspace/commit/range；每种 7 个变更项全部与 Git 比对，默认 4 可审查/3 排除，显式测试 include 为 5/2。删除与 vendor 排除仍可见，重命名旧路径由 Git 补充，全部待审文件取得规则来源/哈希。CLI 前后内容、Git 状态及 HEAD 不变，合成仓库结束后清理。
- 五类真实 CLI 失败保留非零退出；离线契约及实际子进程覆盖异常 JSON、路径/版本/清单失配、失败、超时与合并输出超限。真实超时子进程树收束有 PID 核对，未知收束不显示通过。报告仅含合成文件清单和规则哈希，无本机路径/源码/规则正文。
- [实测与复验](r0/OCR-DELEGATE.md)、[匿名报告](r0/ocr-delegate-report.json)：OCR **18/18**，R0 合计 **35/35**；现有测试 **19 通过/1 Windows executable-bit 场景跳过**；类型检查和构建通过。R0 仍需单独运行；工具未配置时真实 OCR 集成项明确跳过。
- 自行 review 后补充绝对 repository/空及 NUL 参数校验并复验；18 份 Markdown/75 个本地链接、围栏、匿名报告和 git diff --check 检查通过。无真实 CLI 路径配置的探针实测返回 unavailable/退出 1，未伪装成功。
- 临时资源：正式探针仓库通过自身清理已删除；额外源码探索/帮助检查目录的 PowerShell 清理被自动审批审核拒绝，仅返回 blocked by policy、未给具体原因，仍保留在项目外。未改换方式绕过拒绝；下载的固定工具也在项目外留作复验。
- Gate B、R0、v1 未完成；固定旧/新侧完整 diff、复杂范围/空变更/符号链接、正式覆盖策略、其他平台待验收。UI/旧开发入口未改，未运行真实模型、发送用户源码、部署沙箱、复验浏览器或发行安装。

## 11. 2026-09-27 · 审查输入与复杂 Git 场景

- 开始时 main/远程仍为 `778f1f1`，上一切片未提交改动保留；未发现 Iteroom/DSH/R0 Node 服务，不停止其他进程。本轮没有新增提交、推送、产品依赖或 UI/启动器改动。
- 新增独立 `review-files/review-input/ocr-review-input` 与测试。R0 模块仅接受项目外受管合成仓库；历史内容从 Git blob 取得，工作树逐级普通文件检查并在前后核对，输出旧/新路径、内容/diff 哈希和固定字符串。外部 gitdir/链接、超限、不可定位和不支持编码拒绝；BOM/CRLF 保留，二进制不伪装文本。
- 唯一 merge-base 范围、root 对空树、merge 对第一父、空输入 no_changes 均有实际 Git/CLI 证据。多个最佳 merge-base 和无共同历史明确拒绝，实际 Windows junction、Git mode symlink、持续外部改动也有拒绝证据。
- 固定 OCR v1.12.9 继续使用已校验 Windows amd64 文件。实际 8 组场景/23 次无模型 CLI 调用及 5 组 Delegate 前拒绝；全部待审路径取得规则。测试显式 include，文本删除用旧侧内容/规则建立 pending_inference，binary/provider 排除可见；未运行审查推理。
- [接口与复验](r0/REVIEW-INPUT.md)、[匿名证据](r0/ocr-review-input-report.json)只公开合成元数据与哈希，仓库已清理。工作树前后核对不是原子快照，尚未在独立不可变副本上调用 OCR；Gate B/R0/v1 均未完成。
- 最终本轮新增 **20/20**，全部 R0 **55/55**（含 DSH 模拟循环、两组真实 OCR CLI 集成及本机 Git/文件测试）；现有产品测试 **19 通过/1 Windows executable-bit 场景跳过**，类型检查、构建通过。真实模型、OpenSandbox、Web smoke/浏览器、发行未运行。下一步固定副本调用、无 HEAD 工作树及 attributes/filters 边界，然后逐项收口 Gate B，不提前接 R1/R2。
- 自行 review、20 份 Markdown/91 个本地链接、围栏、匿名报告结果/隐私、新增文件空白及 git diff --check 通过。正式权限与原子快照没有因探针通过而标记完成。

## 12. 2026-09-27 · 固定副本与授权实际沙箱

- 开始时 main/远程仍为 778f1f1，保留全部已有未提交改动；无已跟踪 Actions workflow、gh run list 无记录。没有新增提交、推送、产品依赖、UI 或开发入口变化。
- [固定副本](r0/FIXED-REVIEW-COPY.md)独立重建 Git objects/index/字节并复验输入哈希。源在复制后修改，实际 OCR 仍读取副本；六组场景及无 HEAD 共 20 次 CLI 调用通过。无 HEAD 仅接受 staged 一致新增与 untracked，分歧拒绝；attributes/filter/include/fsmonitor/外部 objects 等保守拒绝。新增 fixed-copy 11/11；连同既有 DSH/OCR 为 66/66（包含三组真实 OCR CLI 集成）。限定平台与输入边界内 Gate B 通过，非原子/非 OS 只读及真实项目接线限制仍保留。
- 用户授权无模型 Docker/OpenSandbox 验证，未授权真实模型。Docker 启动曾分别因 Inference socket、Secrets Engine socket 出错；仅备份临时 Docker/run 目录并停止本次启动的进程，未改 Secrets Engine 数据。用户选择自行修复后探针确认 Server 29.4.0，再继续沙箱验证。备份保留在项目外，不自动恢复/清除。
- 在项目外安装固定源服务 0.1.0.dev1+g4a5619524/Python 3.10.20、npm SDK 1.1.0，公开 execd/egress/Node 镜像拉取后按 digest 固定。独立服务回环 3088、临时 key、遥测关闭、受控环境、无用户路径挂载；既有 Docker 容器不停止或清理。项目 package.json/lock 不变。
- [实际运行报告](r0/sandbox-runtime-report.json)：先记录真实分配再等健康；文件导入/修改、node --test 失败/成功、下载哈希、宿主磁盘合成输入未变通过。实际核对 1 CPU/512 MiB/pids128/no-new-privileges、无 bind、env 不含控制 key。前台/后台 interrupt 与 2 秒命令超时均以执行查询及父子 /proc 状态核对停止。删除由 API 404、应用/egress Docker 标签为空与已记录 managed volume 消失核对。
- 实际发现 mode 数字序列化/八进制解析、SDK argv 与 execd command 契约差异，以及发布端口范围至少 100 个的约束；修正探针并补实际参数字面值测试。SDK SSE 在响应头后取消 AbortSignal 转发，实际失败报告保留；通过公开 factory 使用真实 native fetch 后，实际断线仍见远端 running，显式 interrupt 并核对父子停止，不重放。限制见 [SANDBOX-RUNTIME](r0/SANDBOX-RUNTIME.md)。仅 deny 策略回读通过，未证明 DNS/直接 IP 阻断。
- 沙箱预检/运行测试 7/7（实际执行授权、真实安装与引擎下），与上一组分别验证合计 73 项；未配置工具/安装/授权时真实项跳过或 unavailable，不能代替实际证据。现有测试 19 通过/1 Windows 文件执行位跳过，类型检查与构建通过。R0 测试仍须单独运行。
- Gate C 尚缺 TTL、临时控制服务重启、可恢复清理失败与网络执行/降级检测；Gate A 尚缺自有 DSH 沙箱工具与真实模型。Web smoke/浏览器/发行未复验，产品 A01–A21 未改为通过。下一步只推进上述 R0 缺项，不提前迁移 R1/R2。
- 结束清理已核对临时服务进程链与启动时间后仅停止该服务，3088 无监听；本次应用沙箱均已删除。原 4 个 Docker 容器状态保持，另外发现其他会话创建的 1 个容器，未碰。隔离安装/镜像缓存和 Docker/run 备份留在项目外，Docker Desktop 不停止；见[清理报告](r0/sandbox-cleanup-report.json)。后续复验须重新启动自己的临时服务，不沿用预检报告为实时状态。
- 最终相关沙箱测试 7/7 通过（包含真实 SSE 断线及 native fetch 适配）；24 份 Markdown、121 个本地链接、9 份匿名报告、围栏、新增文件空白、R0 脚本语法和 git diff --check 通过。最终重新核对本地/远程均为 778f1f1，工作区未提交改动保留；没有将这些本机结果称作远程 CI。

## 13. 2026-09-27 · 实际沙箱生命周期与网络收口

- 保留全部已有改动，main/远程仍为 778f1f1；未提交、推送、发布，未更换产品 UI、依赖或开发入口。沿用无模型合成沙箱授权，没有读取用户源码或配置、没有请求真实模型，没有修改 Docker 配置或停止其他服务。
- 新增受管服务控制器和故障探针。核对 PID/创建时间/配置路径后才结束自己的进程树，端口占用拒绝；日志只保存长度/哈希。每次两应用沙箱串行，峰值为 1。
- [实际故障报告](r0/sandbox-faults-report.json)：deny 下公开 IPv4 DNS 失败，允许 example.com 后 DNS 和同 IP TCP 443 成功，撤销后同 IP TCP 失败；实际网络状态 ok/dns+nft。临时控制服务重启后原执行仍运行，启动标记只一次；显式 interrupt。关闭服务导致删除请求实际失败，确认 Docker 资源仍在，恢复后删除并核对 API、应用/egress 与卷。
- TTL 60 秒、命令超时 120 秒；临近到期 8.864 秒时确认 running 与父子 /proc 非僵尸存活。未主动 kill，API 404 后再等实际容器/卷消失，回收核对为 4 次轮询/1714 毫秒。原 30 秒 TTL 拒绝、SDK SSE 问题及创建超时均保留失败证据。
- 初始 5 秒创建请求超时并不表示无分配；两个合成分配实际按 owner 核对回收。[失败与恢复报告](r0/sandbox-create-timeout-report.json)保留该区别。创建前写入 owner/pending；未知分配或清理失败时保留控制服务和待核对日志，拒绝下一探针自动启动。延迟分配判定由离线测试覆盖，未进行实际竞态注入。
- 最终故障测试 **8/8**（7 离线 + 1 实际综合集成），之后匿名 UUID fixture 调整又跑离线 **7 通过/1 明确跳过**；类型检查、既有测试 **19 通过/1 Windows 平台跳过**、构建通过。前轮 DSH/OCR 66/66 和基本沙箱 7/7 为分别执行的历史证据，不宣称本轮一次全量 81 项。
- [Gate 汇总](r0/GATES.md)：Gate B/C 在固定环境与受管合成输入边界内通过；网络不涵盖 IPv6/全部协议/宿主端点，清理故障仅注入控制服务不可达。Gate A 仍缺自有 DSH 实际沙箱工具循环及真实模型，R0/v1 未完成，A01–A21、浏览器与发行未验收。下一步仍做 R0 Gate A，不提前迁移 R1/R2。
- 最终自己的临时服务已停、3088 无监听，Docker 全局只读 owner 检查没有剩余本次沙箱；项目外资源日志为 pending=false、cleanupConfirmed=true、ids=[]。隔离安装/镜像缓存/备份保留，不做全局 prune；未清理其他容器。
- 最终检查 27 份 Markdown、155 个本地链接、12 份匿名报告的 JSON/隐私边界与围栏通过；R0 新脚本语法、新增文件空白、git diff --check 通过。独立审查两项重要问题已修正并复验。远程 main 重新核对仍为 778f1f1，gh run list 仍为空，本机结果不冒充远程 CI。

## 14. 2026-09-27 · DSH 与实际沙箱工具组合

- 开始实时核对 main/远程仍 778f1f1，Docker Linux engine 29.4.0、3088 空闲且没有本次 owner 沙箱。全部已有 diff 保留；没有 commit/push、改产品依赖、UI/入口或 Docker 配置，没有读取用户源码/旧配置或请求真实模型。
- [组合探针](r0/DSH-SANDBOX.md)只给官方 CLI sdk-minimal Profile/Patch 新增一个限定动作工具和模拟模型适配器，复用本仓库 JSON-RPC/持久事件辅助函数。DSH 仍负责原 Loop/Session；Iteroom 工具做实际 SDK 远端修改/测试与归属、错误、取消核对，不复制上游内部 scheduler。
- [成功报告](r0/dsh-sandbox-report.json)：repair 实际修正合成 add.mjs、Node 测试退出 0，模拟模型接到真实结果继续；fail 实际退出 7，isError 与模型下一步错误保持；guard 拒绝额外 path，正文执行次数为 0。宿主合成输入哈希未变。
- 取消前实际核对两个不同正整数 PID、父子 /proc 非僵尸；Agent.cancel 触发工具 signal 后显式 interrupt/query，再确认父子 ENOENT 或僵尸与 whenIdle。重启 CLI 后公开 agents.resume 恢复已结束/已取消会话，历史前缀/序号与四会话保留；远端三行 actions 和一次 starts 未增加，取消父子仍停止。不证明产品未知执行恢复。
- 首次 factory prototype 方法未转发在分配后失败，SDK 自动删除；[失败/归属核对报告](r0/dsh-sandbox-adapter-failure-report.json)保留 API404、应用/egress/managed volume 消失和服务停止。修正为公开方法显式转发，在 lifecycle 返回时登记 ID/捕获卷；SDK 已删除时仍完成 Docker 核对。
- 独立审查发现 2 Important / 0 Critical：取消前父子证据及停止时错误处理不够严格；挂载清单未知可能误报回收。两项已按失败测试修正：严格 PID/stat/ENOENT 判定、实际取消前父子核查；未知清单不确认清理/不停止控制服务，持久化 allocated IDs/managed volumes 和待核对状态。清单异常/权限异常为离线边界测试，未冒充实际故障注入。
- 最终组合 **10/10**（5 离线、1 实际综合集成、4 子测试），原 DSH **17/17** 另复验；类型检查、既有产品 **19 通过/1 Windows 平台跳过**、构建通过。不是一次全量 R0 通过，npm test 不含这些探针。
- 成功探针仅创建一个应用沙箱；最终 API/Docker/卷确认删除，3088 无监听、owner 沙箱为空，项目外日志 pending=false、inventoryCaptured=true、cleanupConfirmed=true、remainingIds=0。自己的服务和两次 CLI 均退出，成功后的本次 DSH 临时目录清理；安装/镜像缓存保留，不清理其他容器。
- Gate B/C 限定范围通过；Gate A/R0/v1 未完成。最后真实模型项仍缺授权、提供方/模型、凭证位置和预算，本轮已发出明确问题；未授权不自动读取旧凭证或发请求。产品任务/权限/快照/补丁/UI/浏览器与发行仍未接线或验收，下一步只完成 R0 真实模型证据及逐项审计。
- 最终 29 份 Markdown、171 个本地链接、14 份匿名报告 JSON/隐私边界/围栏、新增文件空白、脚本语法与 git diff --check 通过。HEAD 仍 778f1f1，远程本轮开始核对相同，gh run list 为空；所有新切片未提交，本机结果不是远程 CI。

## 15. 2026-09-27 · 真实模型前的请求约束

- 保留全部已有改动。只用固定公开 DeepSeekAdapter/resolveAdapterOptions 和自己的回环 HTTP/SSE 服务；不读取旧凭证，不调用真实模型，不新增沙箱或改变产品依赖/UI/入口，没有 commit/push。
- [请求守卫与协议](r0/MODEL-TRANSPORT.md)：固定路由/模型、最多6次、输出<=256 tokens、请求<=64KiB、thinking disabled、固定文本及工具结构。预留并 await commit 后才能 HTTP，失败/取消不返还、写入失败停止；拒绝自定义连接器和路由 header，不自动重定向。
- 新增测试最终8/8：7离线边界 + 1实际本机集成。官方 adapter 实际3次合成 HTTP，text SSE、401 AUTH、Abort及停止服务器前的客户端断线通过。[匿名报告](r0/model-transport-report.json)不含正文、凭证、原始响应或私有路径。
- 独立审查0 Critical / 2 Important / 1 Minor。两项重要问题（透传连接器、嵌套工具结构不严）均先失败复现再修正通过；Minor 是报告只保留最后一次 wire 输出/thinking观察，已记录限制，守卫仍逐次校验。未再次审查，不把报告快照解释为逐次证据。
- 请求计数不是金额上限，commit回调/状态回读不是跨进程原子磁盘日志；授权来源、合成数据来源及transport可信性由调用者落实。真实提供方/模型/凭证位置/费用授权仍待用户回复，不重复索取已有无模型沙箱授权。Gate A/R0/v1未完成，下一步仍是获授权后的真实模型证据。
- 最终npm.cmd类型检查、构建通过，既有产品测试19通过/1 Windows执行位场景跳过；32份Markdown/192个本地链接/15份报告JSON与隐私边界、脚本语法/新增文件空白/git diff --check通过。未复验浏览器/发行，没有远程CI记录；本地与远程main均778f1f1。自己的回环服务已停，3088无监听，iteroom-r0-owner沙箱列表为空；没有停止Docker或其他容器。

## 16. 2026-09-27 · 已指定模型与私有磁盘计数准备

- 用户指定 DeepSeek 官方 https://api.deepseek.com / deepseek-flash，要求将 Key 写入项目外配置；只保存到 %LOCALAPPDATA%\Iteroom\r0-model.json，不回显/不入仓库，未发送模型请求。费用上限与真实调用授权问题已发出，尚未回复；此准备切片不读取 Key 或修改其配置。
- 新增[私有磁盘计数](r0/MODEL-JOURNAL.md)与本机探针；仅 temp 根下受管目录，identity/attempts普通文件、独占锁、flush+rename、连续计数、不自动解除残留锁。guard仍复用原commit/state接口，产品入口/依赖/UI未变。
- 新增7/7（5本机文件/边界、1锁初始化I/O注入、1独立Node综合探针），与已有模型守卫/回环SSE8项合跑15/15。实际跨进程竞争锁、子进程预留后合成transport失败、退出重开保持1次/预算耗尽、预留后直接退出保留锁均验证；实际目录替换导致写失败后发送0次。匿名报告actualHttp=false/actualModel=false。
- 独立审查0 Critical / 1 Important / 0 Minor。锁初始化部分写失败会漏关句柄，回归先失败再修正：finally关闭本次handle、未知锁保留、原始I/O错误保留。该失败是注入ENOSPC后实际文件/句柄核对，不宣称真实磁盘满。仅一次修正，无重复审查。
- 官方价格/发布公共资料已核对模型标识、工具支持与峰谷计价，不表示Key/余额/路由已验。请求计数仍不是金额约束；Windows断电持久性、恶意同权限竞态、残留锁自动处理及模型执行中崩溃未验；真实探针/产品预算存储未接。Gate A/R0/v1未完成。

## 17. 2026-09-28 · R0 Gate A 真实组合与技术阶段收口

- 开始时 `main` 与远程 `main` 均为 `778f1f1`，已有所有未提交改动保留。Docker Linux 29.4.0、固定沙箱安装就绪、3088 空闲且本次 owner 容器为空。没有改 Docker 配置、产品 UI/入口/依赖，也未提交或推送。
- 用户授权本轮最多 6 次官方 DeepSeek `deepseek-flash` 请求、单次输出不超过 256 tokens、人民币费用上限 5 元；只发送合成输入。项目外配置的 `maxCostCny` 设为 5，Key 未输出或入仓库。[本地费用预检](r0/DSH-LIVE.md)按固定峰价与偏高系数计算 6 次上界约 2.691072 元；非服务商硬限额或实际账单。
- [真实组合报告](r0/dsh-live-report.json)：官方 DSH/Cordis Profile/Patch、DeepSeekAdapter、原 Agent Loop 和实际 OpenSandbox 共同运行。3 次真实模型请求，模型先调用合成内存只读工具，再调用自有沙箱修复/测试工具，实际 Node 测试退出 0，工具结果进入下一步。模型用量为非缓存输入 866、缓存读取 640、输出 177 tokens。宿主合成输入未变。
- 重启后 1 个 DSH Session 历史前缀/序号保留，远端动作仍 1 次，模型请求数未增加；两个 CLI 进程退出 0，沙箱/卷/控制服务及本次临时预算目录清理核对。既有[模拟模型+实际沙箱](r0/DSH-SANDBOX.md)另复验 11/11，覆盖远端失败、guard 拒绝、取消父子停止和结束/取消会话恢复，不伪称这些错误/取消来自真实模型。
- 本轮无模型相关测试 44 通过、1 个未启用的实际沙箱集成跳过；显式实际组合单独 11/11。固定 OCR v1.12.9 真实 CLI、输入与副本回归另为 49/49。沙箱边界离线测试 12 通过、3 项未启用实际集成跳过；本轮沙箱预检就绪和 DSH/实际沙箱组合已经单独运行，生命周期/网络证据沿用 2026-09-27 固定版实测。现有产品测试 19 通过、1 项 Windows 文件执行位跳过；`npm.cmd run check` 与 `npm.cmd run build` 通过。各组不是一次合并全量运行；真实模型组合为独立 3 请求实测，未再次收费重跑。
- 文档检查：32 份 Markdown 的 189 个本地链接可定位，17 份匿名 JSON 可解析；真实报告隐私扫描通过。工作区 127 个 Git 可见文件均不含本次项目外 Key；`git diff --check`、新增脚本语法和最终本地/远程 `778f1f1` 对齐检查通过。3088 无监听，本次 owner 容器为空；未运行浏览器或 npm 发行验收。
- Gate A/B/C 在固定版本、Windows→Linux Docker 与受管合成输入范围内完成，R0 **技术验证**收口。真实提供方失败/流取消、服务商账单、产品未知执行恢复、用户项目输入快照/补丁接受、A01–A21、浏览器及发行未验；R1/v1 未完成，不能把独立 PoC 当成可用的受控编程助手。

## 18. 2026-09-28 · R0 推送与 R1-1 任务登记

- R0 的 77 个文件经暂存边界、私有 Key 和报告路径检查后提交为 `b240fa0`，已推送 `origin/main`。本节之后的 R1-1 改动尚未提交或推送；旧 DSH Web 入口、方案 C UI 和项目外安装未迁移。
- [R1-1 接口与实施记录](r1/TASK-ENTRY.md)：新增 `ManagedTaskStore` 与独立 GET/POST 路由。任务只保存本次启动项目、目标、路径意图和 `queued/not_started`；没有 Session/Execution、模型请求、源码读取、沙箱或宿主命令。相同 requestId 重试返回原任务，变更内容或第二个活动任务拒绝。新 JSON 与旧证据/DSH Session 分目录，项目内数据目录、损坏记录和未知锁失败关闭。
- 本机合成项目单测覆盖输入和 Windows 路径、并发/重启去重、越界与损坏状态，以及指向项目内的目录 junction；实际 DSH Web carrier 的合成 smoke 覆盖认证/跨来源、分块超限 413、登记时模型请求数不变、宿主 README 不变、重启后查询。该 smoke 的其他旧流程使用本机模型 stub，并非本轮真实 DeepSeek 调用。`npm.cmd test` 26 通过/1 Windows 文件执行位跳过，`npm.cmd run check`、构建和 `npm.cmd run test:web` 通过；`npm.cmd pack --dry-run --ignore-scripts` 确认两个新增 Host 模块在包内（仅打包清单检查，未做干净安装）。
- R1 下一切片须在文件读取前固定和复核允许范围，提供只读 DSH 工具与任务/Session 关联、可定位引用、事件游标和 UI；当前登记任务不会自行执行，也没有完成/放弃动作，因而不能启动第二个任务。R1/A02/A12/A13/A21 及 v1 均未完成；不得把旧 DSH 宿主执行入口视为受管只读模式。

## 19. 2026-09-28 · R1-2 选定文件受限读取

- [接口与实施记录](r1/READ-SCOPE.md)：新增 `POST /api/iteroom/managed-tasks/read`，沿用现有 DSH Connection Cookie 与来源保护；服务端只取当前项目和任务创建时选定的路径。逐段拒绝符号/硬链接、junction、非普通文件、项目外路径，限制单文件 256 KiB，并拒绝非 UTF-8/NUL。响应不缓存，项目外任务 JSON 只保存 SHA-256、字节数、行数、首次读取时间；内容变化后拒绝，不覆盖首次摘要。
- 旧 R1-1 记录缺少 `readObservations` 时按空列表兼容；没有旧证据或 DSH Session 迁移，未动用户项目文件。路径核验/打开/复核不是 OS 原子操作，摘要不能复原正文，不能称为完整输入快照。当前 `queued/not_started` 状态不变，读取不触发模型、沙箱或 Host Shell。
- 本机合成单元 `npm.cmd test`：32 通过、1 个 Windows Git executable-bit 用例跳过；`npm.cmd run check`、`npm.cmd run build`、`npm.cmd run test:web` 通过。Web smoke 验证新路由认证/跨源/未选路径拒绝、真实本机文件读取、无模型请求、重启后摘要存在；`npm pack --dry-run --json --ignore-scripts` 确认新模块包含在包内。未进行浏览器交互、真实模型、OCR、OpenSandbox 或独立安装验收。
- 固定版 R0 已验证独立 `sdk-minimal` Profile 的自有工具注册；现有产品 Web Profile 仍有原 DSH 写/执行工具，直接添加只读工具无法形成受管隔离。本轮未把模型接到该接口。R1 下一切片是可复读固定输入与隔离的 DSH 自有只读工具，再建立 taskId/Session/turn、引用位置、事件与恢复和 UI。受管任务尚不能完成/放弃或登记第二个任务；R1、A02/A04/A12/A13/A19/A21 及 v1 未完成。本轮 R1 改动均未提交/推送。

## 20. 2026-09-28 · R1-3 固定输入副本

- 新增[固定输入](r1/INPUT-SNAPSHOT.md)：已认证 `POST /api/iteroom/managed-tasks/snapshot` 固定任务选定文件至项目外 `managed-snapshots-v1`，任务 JSON 保存 `snapshotId`。`readManagedSnapshotFile` 在读取时校验任务、清单与副本 SHA-256；源工作树变动不会使重试读取变成新内容，损坏时拒绝而不回退宿主文件。旧任务缺字段兼容，目录写成而任务关联未写成可经重试恢复。
- 本轮 `npm.cmd test` 36 通过/1 个 Windows 执行位跳过，`npm.cmd run check`、`npm.cmd run build`、`npm.cmd run test:web` 和 `git diff --check` 通过。Web carrier 验证快照路由认证/跨源拒绝、项目 README 不变、未新增模型 stub 请求及关联重启保留；本机单测覆盖源变动、损坏、失败重试与旧记录。未运行真实模型、浏览器 UI、实际沙箱、OCR 或发行安装。
- 多文件采集并非 OS 原子快照，同权限本机进程可在路径核验期间竞争；本轮副本是应用层哈希固定输入，不是完整 R2 工作区快照。受管模型工具、Session/turn、引用、事件、取消与用户 UI 仍未接；旧 DSH Web Profile 宿主工具仍可用。R1/v1 未完成，本轮 R1 改动未提交/推送。

## 21. 2026-09-28 · R1 受管只读入口与真实失败

- 保留 R1-1/2/3 的未提交改动，HEAD/远程仍为 `b240fa0`；没有提交或推送。现有 DSH Web 开发入口与方案 C 白色 UI 保留，另加“代码理解”独立面板；旧 Web Profile 仍具有原宿主能力，不能视为受管只读模式。
- 自有 Host/任务协调器先固定选定 UTF-8 文本，再在每任务独立 `sdk-minimal` CLI/`DSH_HOME` 启动固定 DSH Loop。Patch 禁用宿主执行工具，只注册 `iteroom_read_snapshot`；保存 taskId/sessionId、状态、引用与单调事件游标。取消等进程退出，重启将未拥有的运行任务标为 interrupted，不重发相同任务。旧记录缺事件时只显示“已有状态”基线；该路径尚未做实际崩溃/遗留子进程注入。
- 用户授权本轮最多 4 次 `deepseek-flash` 请求、单次输出≤256 tokens、人民币 5 元上限，仅合成输入。[真实记录](r1/READONLY-LIVE.md)：私有日志预留 4 次，模型确实调自有只读工具，但前三次结束行越 EOF 均失败；任务以 `ENGINE_TURN_FAILED` 结束，没有可确认的回答和引用。第四次预留不等于已确认计费；未查服务商账单。达到次数上限后不再请求。随后修复工具 EOF 截断，官方 CLI+模拟模型回归通过；**没有新的真实成功结果，R1/A02 未完成**。
- 本机浏览器在合成项目验证任务创建、失败显示、历史切换、刷新/重启可查询、无凭证时启动拒绝及 390×844 布局。仅为 UI/本地 HTTP 证据。合成 Git 项目保持干净；没有沙箱/OCR、用户源码传输或宿主 Shell。最终 `npm.cmd test` 51 通过/1 Windows 执行位跳过，`npm.cmd run check`、`npm.cmd run build`、`npm.cmd run test:web` 通过。`npm pack --dry-run` 确认 5 个关键新入口在包内，但未做干净安装；39 份 Markdown 本地链接、`git diff --check` 与本轮新增文件名/长 token 模式核对通过。临时 Web 服务已停止。
- 本地追加模型文本增量管道：官方适配器公开 `prepareCall` 的 `text-delta` 经受限第 4 管道到 Host，持久任务草稿与事件，UI 仅在运行中以“尚未核实”展示。官方适配器/本机合成流、模拟 Loop 与持久草稿均有离线测试；该修改晚于 4 次真实请求，真实提供方流显示未验。
- Windows 本机合成故障注入在模型等待时强制结束 Host，确认受管 DSH CLI 随 stdin 断开退出；新 Host 将原任务标为 interrupted，不重发，源文件未改。另对运行中取消确认 CLI 退出。该结果不覆盖真实提供方断线、其他平台或未来沙箱子进程。
- 当时 R1 尚缺修复后真实模型完成与准确引用/增量展示、真实网络中断边界和独立发行 Host；后续第三轮真实结果见第 23 节。未做干净安装/发行验收，不能称 v1 完成。当时的两轮用户授权均已耗尽。

## 22. 2026-09-28 · 第二轮受管真实复验与离线收口

- 用户另授权最多 3 次 `deepseek-flash` 请求、每次输出≤256 tokens、人民币 5 元上限，仅传新的合成任务/代码/只读工具 schema。[受管真实记录](r1/READONLY-LIVE.md)显示 3 次请求预留全部用完：第一步请求 `1–200` 被当时的请求跨度限制拒绝，第二步 `1–1` 成功读到固定的一行文件，第三步保存了文本增量，但未取得完成的 DSH turn/最终回答/引用，任务仍为 `failed / ENGINE_TURN_FAILED`。没有核对服务商已计费次数或账单；项目外合成仓库未变，临时 Web 服务已停止。
- 失败后把读取范围限制改为按实际返回内容裁剪至 EOF、最多 120 行/16 KiB，并在提示中给出准确行数和简短回答约束。官方 CLI+模拟模型对 `1–200 → 1–1` 的回归通过；修正晚于第二轮真实请求，不是线上成功证据。两轮真实授权分别用满 4 次和 3 次，后续真实调用须有新授权。
- 修正后的最终本机检查：`npm.cmd test` 51 通过、1 个 Windows 执行位条件跳过；`npm.cmd run check`、`npm.cmd run build`、`npm.cmd run test:web`、`git diff --check` 通过。`npm.cmd pack --dry-run --json --ignore-scripts` 确认受管 Host、引擎和 UI 构建产物在清单内；未做干净安装、真实模型完成、真实网络断线、浏览器流式中间帧或其他平台验证。HEAD/远程仍为 `b240fa0`，R1 工作区改动未提交/推送；R1/A02/v1 均未完成。

## 23. 2026-09-28 · R1 受管只读 Gate 通过（限定范围）

- 用户第三轮另授权最多 4 次 `deepseek-flash` 请求、单次输出≤512 tokens、人民币 5 元上限，只发送全新合成代码/任务/只读工具 schema。Host、子进程、官方适配器和磁盘发送前守卫使用相同上限；本机回环测试验证 512/513 tokens 与第四次/第五次请求的通过/拒绝边界。本轮实际仅预留 **2 次**，未使用剩余 2 次；服务商账单和人民币硬限额均未核对。
- 新合成 Git 仓库仅含 `src/example.ts` 一行 `export const answer = 42`。经已认证受管 Web API 建立并启动任务；DSH Session 留有 1 次 `iteroom_read_snapshot` 调用/成功结果和 `turn/end: completed`。回答说明 `answer` 为 42，引用 `src/example.ts:1`；来源 API 对快照 ID、哈希和固定字节核对通过。仓库前后 `git status --porcelain` 为空，原文件 SHA-256 不变。[完整记录与复验命令](r1/READONLY-LIVE.md)。
- 停止并重新启动 Host 后，任务仍是 completed，浏览器显示答案，点击来源展示第 1 行；请求日志重启前后均为 2 次。[浏览器截图](r1/managed-live-completed.png)只含合成代码。390×844 窄屏的完成态 DOM 可见回答和来源；真实生成中间帧未捕获，服务端实际有 1 条草稿事件，不能外推为视觉流式链路全程通过。临时浏览器与 Host 已关闭，端口无监听。
- 最新本机 `npm.cmd test` 53 通过/1 Windows 执行位条件跳过，`npm.cmd run check`、`npm.cmd run build`、`npm.cmd run test:web` 通过；打包仅查清单，未做干净安装。R1 自有受管任务/权限/快照/验证与 DSH 最小引擎组合的退出条件在 Windows/固定版/单项目合成文本范围内通过；旧 DSH Web 完整入口仍有宿主工具，独立发行 Host、真实提供方断线、真实用户仓库、其他平台、R2–R5 和 v1 均未验收。HEAD/远程仍为 `b240fa0`，R1 改动未提交/推送。
