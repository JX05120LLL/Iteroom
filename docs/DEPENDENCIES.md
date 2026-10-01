# 第三方复用与归属

> 2026-09-26 · 本文是依赖决策清单，不是已完成许可证审计或已锁定的新依赖清单。

| 项目 | 来源 | 选用范围 | 当前状态/许可 |
|---|---|---|---|
| Cordis 配套发行版 | [DSH vendor/cordis](https://github.com/deepseek-ai/deepseek-harness/tree/master/vendor/cordis) | 插件、依赖和生命周期 | 本地 4.0.2 包 manifest 为 MIT；不是泛用 cordis 包的可互换承诺 |
| DeepSeek Harness | [官方仓库](https://github.com/deepseek-ai/deepseek-harness) | Loop、模型契约及最小兼容服务；必要持久化/provider | 当前全量 0.1.5-rc.3；本地已检查 Loop/Cordis 包为 MIT，最终包集合逐项审计 |
| OpenCodeReview | [官方仓库](https://github.com/alibaba/open-code-review) | Delegate 文件/规则准备、选择性规则参考 | R4-1 接入产品准备；研究 SHA 486022d；实测官方 v1.12.9 / bccbc15f Windows amd64；[Apache-2.0](https://github.com/alibaba/open-code-review/blob/main/LICENSE) |
| OpenSandbox | [官方仓库](https://github.com/opensandbox-group/OpenSandbox) | TypeScript SDK、Docker 沙箱执行服务 | R2 受管隔离修改直接依赖 SDK 1.1.0；服务沿用项目外固定安装/SHA 4a56195，未捆绑发行；[Apache-2.0](https://github.com/opensandbox-group/OpenSandbox/blob/main/LICENSE) |

DSH 包内 UI 可以继续作为迁移期基线；目标产品 API、任务状态和交互由 Iteroom 定义。凡复用上游 UI、规则、工具或算法，都保留来源说明，不因品牌修改改变代码归属。

2026-09-27 的 UI 决策继续复用 DSH 界面主体，Ant Design 用于 Iteroom 自有任务、审阅与配置控件。独立原型采用 antd 6.6.5 / @ant-design/icons 6.3.4；主产品尚未安装，实际接线在 R1 核对兼容与分发归属。本轮 R0 检查沿用 DSH 已安装的 js-yaml，不新增依赖。

## 发行前检查

[R4-3](r4/FIX-EVIDENCE.md)新增的来源关系、修复/复查协调、Hash 校验、准备收束与面板导航属于 Iteroom；复用现有 DSH/Cordis、OCR 与 R2/R3，不添加依赖、复制上游 Loop 或捆绑 OCR 二进制/规则正文。当前 npm 包只核对清单，完整分发归属与安装仍待 R5。

[R4-1](r4/EVIDENCE.md)在 npm 包内新增 Iteroom 自有的输入边界、协调器和快照模块，R0 入口保留兼容导出；没有捆绑 OCR 可执行文件或复制其 Agent。规则正文仅存项目外准备记录，保留 source/pattern/rule SHA256 与固定版本。未跟踪 provider 目录的省略契约核对固定源 [internal/diff/git.go](https://github.com/alibaba/open-code-review/blob/bccbc15f785269400735d5255540c231e6c02b6d/internal/diff/git.go)，在本项目保持可见的排除元数据。CLI 来源与二进制校验值见 R4 报告；其他平台、干净安装和规则再分发许可证审计仍未完成。

1. 锁定实际验证的 npm 包、OCR 二进制、沙箱服务和镜像版本，保存镜像 digest/来源。研究 SHA 不等于发行版本，主分支变化不自动升级。
2. 核对直接/传递依赖及容器镜像的许可证、版权和 NOTICE，按实际分发范围保留对应文本；不能仅审计顶层仓库。
3. 修改或复制 Apache-2.0 文件时保留适用声明并标注改动；若有适用 NOTICE 一并保留。上游规则在产品报告中可追溯。
4. 第三方名称只用于依赖和归属说明，不暗示厂商背书。Iteroom 自身许可证在正式发行前确定，当前文档不替用户选择授权条款。
5. 记录升级兼容检查：DSH 服务/事件，OCR JSON/schema，SDK/服务协议，沙箱网络/隔离能力以及 UI 回归。

## 接入限制

[模型传输准备](r0/MODEL-TRANSPORT.md)复用现有 DSH 0.1.5-rc.3 导出的 DeepSeekAdapter/resolveAdapterOptions，先对合成本机 HTTP 服务运行；没有复制模型协议或安装产品依赖。请求形状守卫和[私有磁盘计数](r0/MODEL-JOURNAL.md)为 Iteroom 独立 R0 代码；后续[真实模型组合](r0/DSH-LIVE.md)已按用户批准的 5 元上限调用 DeepSeek 官方 deepseek-flash 3 次，使用原 adapter/Loop。费用预检是本地规划，不是服务商硬扣费限额或产品预算存储。

[DSH/实际沙箱组合](r0/DSH-SANDBOX.md)使用固定公开 Agent/Tool/SDK 与相同项目外安装。Iteroom 自己实现动作限定、guard、执行结果核对、父子取消证据和资源归属日志；DSH 提供 Loop/Session，OpenSandbox 提供实际文件/命令执行。adapter factory 方法位于 prototype，需显式转发，公开 SSE fetch 替换保留 endpoint headers。[真实模型组合](r0/DSH-LIVE.md)在这个基础上只增加固定官方模型适配器和项目外预算配置，没有新产品依赖或复制上游调度器。

固定 DSH 0.1.5-rc.3 的[运行探针](r0/DSH-RUNTIME.md)已验证 CLI Profile/Patch 与公开工具/模型/Agent 接口。其 SDK 无单任务取消，已有 Session 的 prompt 不直接恢复；公开核心 Agent.cancel/whenIdle、agents.resume 已用模拟模型验证。保留 DSH Loop/JSONL 实现，Iteroom 后续 Host 负责产品入口与执行治理，不将探针或 SDK 协议当成完整产品后端。

OCR 的 npm 分发入口启动 Go 二进制，非 TypeScript 库，首版进程接入还需验证支持平台、安装与定位。OpenSandbox SDK 是客户端，不能代替服务和 Docker 部署。DSH 当前官方文档限定受支持启动形式；自建 Cordis Host 需要明确支持范围和升级责任。

本轮 [OCR 探针](r0/OCR-DELEGATE.md)只下载并执行项目外的官方 Windows amd64 v1.12.9 文件，启动前核对固定 SHA256 与版本；没有修改 package.json/lock 或分发工具/规则正文。Linux/macOS/ARM64、生产安装升级和完整分发许可证清单待验收，研究 SHA 不冒充实测发行版。

[输入扩展](r0/REVIEW-INPUT.md)复用同一固定文件/校验器，没有再次安装或升级依赖。新增的是 Iteroom 的受管输入定位、内容/diff 哈希与覆盖状态，Git 负责差异/对象语义、OCR 负责规则和默认排除；没有将其推理能力宣称为本轮自研成果。

[固定副本](r0/FIXED-REVIEW-COPY.md)继续使用上述 OCR，不复制上游引擎。授权的[沙箱切片](r0/SANDBOX-RUNTIME.md)在项目外以 uv.lock 安装源码服务 0.1.0.dev1+g4a5619524/Python 3.10.20，以及 npm SDK 1.1.0（ignore-scripts）；package.json/产品 lock 未改。execd v1.1.0、egress v1.1.7、Node 24 镜像 digest/大小及 SDK integrity 见匿名报告。[生命周期/网络探针](r0/SANDBOX-FAULTS.md)复用相同固定安装，通过 SDK 公开 factory/connect/interrupt 接口及归属核对的临时服务控制实现；不复制上游 Loop、SDK 或服务内部实现。尚未形成产品安装升级或发行许可证清单。

来源：[DSH 架构](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)、[OCR Delegate](https://github.com/alibaba/open-code-review/blob/486022daaf14f7142275eddb9b3cacc3cc5dadfa/cmd/opencodereview/delegate_cmd.go)、[OpenSandbox SDK](https://github.com/opensandbox-group/OpenSandbox/blob/main/sdks/sandbox/javascript/README.md)。

[R4-2](r4/INFERENCE-EVIDENCE.md)新增的预算、覆盖、片段定位、报告校验与编排属于 Iteroom。推理由同一固定 DSH sdk-minimal Profile 和公开 CLI/JSON-RPC 执行，现有模型适配器/guard/RPC 复用；没有复制 Agent Loop 或增加依赖。OCR 规则来源和 Hash 随固定上下文只存在项目外，未捆绑二进制或规则正文。
