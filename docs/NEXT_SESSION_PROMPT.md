# 下一次开发提示词

以下为可复制的接续提示词。2026-09-28 的状态只是本轮记录，下一会话先实时核对工作区、服务与授权。

```text
请继续 D:\code\Iteroom，从 R1 受管只读代码理解的限定范围验收接续，先定义 R2 隔离修改与验证的最小切片。R0 三个技术 Gate 已在固定版本、Windows 宿主与合成输入范围内完成；R1 的提交与推送状态以新的 git 检查为准。保留全部已有改动，不自动 commit/push/publish。

先核对 git status、HEAD、远程、CI 和服务状态，读 AGENTS.md、README.md、CONTEXT.md、docs/PRD.md、ARCHITECTURE.md、ROADMAP.md、STATUS.md、ACCEPTANCE.md、docs/r1/READONLY-LIVE.md 与 src/host/managed-*、src/client/managed-understand.tsx 及测试。给简短计划后推进。

已有：项目外版本化任务/固定选定文本、只读路径/哈希检查、独立 sdk-minimal DSH CLI、唯一 iteroom_read_snapshot 工具、每任务持久请求上限与 Session/任务关联、结果引用校验、取消后进程退出、状态事件游标、方案 C 白色代码理解 UI。官方适配器公开文本增量经子进程第 4 管道持久化为草稿/事件，UI 轮询显示“尚未核实”；真实模型确实产生并持久化增量，但浏览器生成中间帧未捕获。Windows 合成强制结束 Host 后 CLI 退出、任务中断不重发已实际验证。旧完整 DSH Web 入口仍在，不能说全局已只读；真实提供方断线和其他平台未验证。

受管真实模型前两轮在各自 4 次/3 次授权内失败。用户第三轮另授权最多 4 次请求、单次最多 512 输出 tokens、人民币 5 元上限；修正后在全新合成仓库实际只用 2 次完成准确回答和 src/example.ts:1 固定引用。DSH Session 有真实 tool/call、tool/result 和 completed turn，浏览器点击引用能看对应行；仓库前后干净，Host 重启前后请求日志均为 2 次。具体边界和截图见 docs/r1/READONLY-LIVE.md。第三轮剩余 2 次不要视为新会话或 R2 的自动授权；新真实调用先核对明确次数、费用和数据范围，且不输出项目外 Key。

R1 受管只读退出条件在 Windows/固定版/单项目合成文本范围内通过，v1 未完成。R2 先定义受管修改任务、工作区快照到沙箱的导入、执行与验证事实、停止核对、补丁导出接口和验收；沿用 R0 OpenSandbox 限定证据但不把探针当产品接线。先做无模型和合成输入的最小实现与验证，宿主原仓库不得被写；实际沙箱部署或新真实模型传输先按本轮授权范围重新核对。独立发行 Host、旧完整开发入口替换、真实网络故障和其他平台均另列风险，不将它们说成 R1 已验证。

运行 npm.cmd test、npm.cmd run check、npm.cmd run build、npm.cmd run test:web、git diff --check；按变化范围运行 R0 沙箱/OCR 回归，核对 npm pack 清单、敏感数据边界和合成浏览器。真实模型、浏览器、发行、R0 既有技术 Gate 分别报告，未重跑的证据只写沿用。接口、状态、数据格式或 UI 变化同步 PRD、ARCHITECTURE、ROADMAP、STATUS、README、ACCEPTANCE 和阶段证据。旧 Task evidence/DSH Session 不迁移、不删除。
```
