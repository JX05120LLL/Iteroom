# 第三方复用与归属

> 2026-09-26 · 本文是依赖决策清单，不是已完成许可证审计或已锁定的新依赖清单。

| 项目 | 来源 | 选用范围 | 当前状态/许可 |
|---|---|---|---|
| Cordis 配套发行版 | [DSH vendor/cordis](https://github.com/deepseek-ai/deepseek-harness/tree/master/vendor/cordis) | 插件、依赖和生命周期 | 本地 4.0.2 包 manifest 为 MIT；不是泛用 cordis 包的可互换承诺 |
| DeepSeek Harness | [官方仓库](https://github.com/deepseek-ai/deepseek-harness) | Loop、模型契约及最小兼容服务；必要持久化/provider | 当前全量 0.1.5-rc.3；本地已检查 Loop/Cordis 包为 MIT，最终包集合逐项审计 |
| OpenCodeReview | [官方仓库](https://github.com/alibaba/open-code-review) | Delegate 文件/规则准备、选择性规则参考 | 未接入；研究 SHA 486022d；[Apache-2.0](https://github.com/alibaba/open-code-review/blob/main/LICENSE) |
| OpenSandbox | [官方仓库](https://github.com/opensandbox-group/OpenSandbox) | TypeScript SDK、Docker 沙箱执行服务 | 未接入；研究 SHA 4a56195；[Apache-2.0](https://github.com/opensandbox-group/OpenSandbox/blob/main/LICENSE) |

DSH 包内 UI 可以继续作为迁移期基线；目标产品 API、任务状态和交互由 Iteroom 定义。凡复用上游 UI、规则、工具或算法，都保留来源说明，不因品牌修改改变代码归属。

2026-09-27 的 UI 决策继续复用 DSH 界面主体，Ant Design 用于 Iteroom 自有任务、审阅与配置控件。独立原型采用 antd 6.6.5 / @ant-design/icons 6.3.4；主产品尚未安装，实际接线在 R1 核对兼容与分发归属。本轮 R0 检查沿用 DSH 已安装的 js-yaml，不新增依赖。

## 发行前检查

1. 锁定实际验证的 npm 包、OCR 二进制、沙箱服务和镜像版本，保存镜像 digest/来源。研究 SHA 不等于发行版本，主分支变化不自动升级。
2. 核对直接/传递依赖及容器镜像的许可证、版权和 NOTICE，按实际分发范围保留对应文本；不能仅审计顶层仓库。
3. 修改或复制 Apache-2.0 文件时保留适用声明并标注改动；若有适用 NOTICE 一并保留。上游规则在产品报告中可追溯。
4. 第三方名称只用于依赖和归属说明，不暗示厂商背书。Iteroom 自身许可证在正式发行前确定，当前文档不替用户选择授权条款。
5. 记录升级兼容检查：DSH 服务/事件，OCR JSON/schema，SDK/服务协议，沙箱网络/隔离能力以及 UI 回归。

## 接入限制

固定 DSH 0.1.5-rc.3 的[运行探针](r0/DSH-RUNTIME.md)已验证 CLI Profile/Patch 与公开工具/模型/Agent 接口。其 SDK 无单任务取消，已有 Session 的 prompt 不直接恢复；公开核心 Agent.cancel/whenIdle、agents.resume 已用模拟模型验证。保留 DSH Loop/JSONL 实现，Iteroom 后续 Host 负责产品入口与执行治理，不将探针或 SDK 协议当成完整产品后端。

OCR 的 npm 分发入口启动 Go 二进制，非 TypeScript 库，首版进程接入还需验证支持平台、安装与定位。OpenSandbox SDK 是客户端，不能代替服务和 Docker 部署。DSH 当前官方文档限定受支持启动形式；自建 Cordis Host 需要明确支持范围和升级责任。

来源：[DSH 架构](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)、[OCR Delegate](https://github.com/alibaba/open-code-review/blob/486022daaf14f7142275eddb9b3cacc3cc5dadfa/cmd/opencodereview/delegate_cmd.go)、[OpenSandbox SDK](https://github.com/opensandbox-group/OpenSandbox/blob/main/sdks/sandbox/javascript/README.md)。
