# R2 隔离修改与验证：2026-09-29 限定证据

环境为 Windows、Node 24.14.0、Docker Linux Server 29.4.0、固定 DSH 0.1.5-rc.3 与 OpenSandbox SDK 1.1.0；OpenSandbox 控制服务复用 R0 的项目外固定安装，服务只在回环 3088 运行。本轮所有仓库和代码都是一次性合成输入，未传用户项目源码；模型凭证只从项目外文件读取，未写进仓库。以下报告不含原始沙箱/执行 ID、密钥或私有请求 ID。

| 验证 | 实际结果 | 边界 |
|---|---|---|
| 实际沙箱，无模型 | [匿名报告](sandbox-smoke-report.json)：固定输入导入；原测试 exit 1，沙箱修复后 exit 0；补丁 `git apply --check` 通过，宿主 Git HEAD、状态和源文件哈希不变；API 404 确认沙箱删除，本次服务停止 | 测试文件被临时改成慢测试只用于故障注入，不纳入补丁 |
| 执行故障与停止 | 同一实际沙箱中，远端执行启动后注入流故障，记录 `SANDBOX_EXECUTION_UNKNOWN` 并显式 interrupt，最终 execution 为 `interrupted`；另在慢测试执行中删除沙箱，execution 为 `interrupted`、退出码未知 | 流故障为注入，不等于真实网络断线；R0 对真实 SSE 断线另有独立证据 |
| 真实模型与真实沙箱 | [匿名报告](model-smoke-report.json)：官方 `deepseek-flash` 经 DSH 最小 Loop 使用自有三工具；磁盘预留 4 次请求、单次最多 512 输出 tokens；真实测试 exit 0，任务 `awaiting_review`，补丁可应用、沙箱已清理、宿主未改 | 服务商账单与人民币硬费用未核对。此运行早于随后增加的产物输入哈希和沙箱文件清单复核；本轮授权 4 次已用尽，没有对最终修订再发模型请求 |
| 最新代码的模型无关组合 | [匿名报告](synthetic-loop-report.json)：模拟模型经真实 DSH CLI/自有工具/实际沙箱完成读取、修改、测试、补丁存取与清理，模型请求 0 次 | 只证明最新接线，不代替真实模型调用 |
| 实际取消 | [匿名报告](cancel-smoke-report.json)：模拟 DSH Loop 正运行时调用 R2 取消接口，任务为 `cancelled / ENGINE_CANCELLED`，实际沙箱已删除，宿主未改 | 取消发生在模型等待阶段；命令执行中停止由上方实际沙箱故障探针覆盖 |
| 浏览器 | 本地真实浏览器在合成项目创建修改任务；无沙箱配置时启动明确提示，任务保留为待启动；方案 C 页面仍可导航。随后新增“放弃待启动任务”按钮并以任务/协调器测试确认无凭证读取或沙箱分配 | 新增按钮未再次做浏览器交互；没有完成态浏览器补丁下载/窄屏视觉验收 |

**ROADMAP R2 的最小退出条件在固定环境/合成现有选定文本范围内通过**：小功能修改、真实测试、候选补丁和宿主不变，以及失败/故障/取消的状态边界均有分层证据。P0-07/A05 的新增、删除、重命名补丁，实际提供方断线、最终修订上的真实模型复验、完整浏览器完成态、干净发行和真实用户仓库仍未验收；R3 的接受/冲突/写回尚未实现。旧 DSH Web 完整开发入口依然有宿主工具，不属于此受管隔离路径。

复验前先核对 Git 工作区、Docker Linux Engine、3088 端口及项目外固定服务/镜像，确认只处理合成仓库。下面三个无模型脚本各自启动并停止自己的控制服务；一次只运行一个，不清理其他容器。`ITEROOM_SANDBOX_POC_ROOT` 指向 R0 已验证的项目外安装根。真实模型脚本还需要明确的新请求/费用授权；本轮额度已耗尽。

```powershell
$env:ITEROOM_SANDBOX_POC_ROOT = '项目外 R0 固定安装根的绝对路径'
$env:ITEROOM_R2_SANDBOX_SMOKE = '1'
node scripts/r2/sandbox-smoke.mjs
$env:ITEROOM_R2_MODEL_SMOKE = 'synthetic'
node scripts/r2/model-smoke.mjs
$env:ITEROOM_R2_MODEL_SMOKE = 'cancel'
node scripts/r2/model-smoke.mjs

# 仅在新授权后，且项目外配置文件有效时运行真实模型切片：
$env:ITEROOM_MODEL_KEY_FILE = '项目外 DeepSeek 配置文件的绝对路径'
$env:ITEROOM_R2_MODEL_SMOKE = '1'
node scripts/r2/model-smoke.mjs
```

受管页面启动需要 `ITEROOM_SANDBOX_KEY_FILE` 指向项目外 `r0-key`、`ITEROOM_SANDBOX_IMAGE` 为 `images.json` 中 Node 镜像 digest，并由操作者单独启动 OpenSandbox 服务。服务不可用时隔离修改失败关闭，不回退 Windows 宿主 Shell。Docker Desktop 的 Linux 容器后端在本机经 WSL2 提供；Windows 仍是 Host/UI，不要求用户项目搬进 WSL。
