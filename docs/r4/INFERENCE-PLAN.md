# R4-2 审查推理与定位实施计划

目标：在已固定 R4-1 准备记录上启动原 DSH Loop，生成有覆盖状态和固定来源的审查报告；本轮先以本地模拟模型验收，不将其写成真实模型或完整 R4 完成。

范围按 PRD 4.3、ARCHITECTURE 的原引擎约束及 [R4 计划](PLAN.md)。保留全部未提交改动、方案 C 和现有入口，不提交/推送，不启动沙箱或发送用户代码。沿用 Node/DSH/Cordis/OCR 固定版本，不新增依赖、不复制 Loop。

## 接口与数据

- `review/plan` GET（taskId）：基于固定准备生成确定性预算预览，不读取新源码。最多 2 个规则分组/拆分包，单包编码上下文 8 KiB、合计 16 KiB；按完整文件两侧和 Diff 选择，不能静默截断。规则与路径均绑定 preparation Hash。过大或超预算的文件保持 pending，并显示原因。
- `review/start` POST `{taskId,requestId}`：同源、认证、8 KiB；本机模型配置就绪后写项目外 plan，claim 任务再启动独立 sdk-minimal。最多 4 次、每次 512 输出 tokens，模型发送前沿用磁盘计数/32 KiB 请求上限。相同请求不重复执行；已有运行或终态不重放。
- `review/result` GET（taskId）：核对 preparation/plan/report Hash，返回 coverage/findings。模型 JSON 精确为 `{groups:[{groupId,findings:[{path,side,quote,message,severity}]}]}`；只接受计划内且实际读过的分组，不接受模型行号。重复发现按固定输入/path/side/quote/message/severity 去重。
- `review/cancel` 同一入口：queued 准备沿用原放弃；运行中先 cancelling、abort、等待引擎退出再保存取消报告。重启的孤立运行无完整报告时标 interrupted；已收束且完整落盘的 Host 报告经覆盖和定位重算后可补关联，不重新发请求。未知终止保持阻塞，不能报告 cancelled。
- 项目外 `managed-reviews-v1/<projectId>/<taskId>/` 新增 `plan.json`、`result.json`，任务版本 1 增加 reviewPlanId/reviewReportId/reviewOutcome。旧 R1–R4-1 记录继续可读；旧程序不读新 review 状态，回退前备份外部数据。

## 不变量与失败场景

1. 原 DSH Loop 只有 `iteroom_review_context(groupId)`；无宿主读写、Shell 或沙箱工具。读取返回固定完整包和 Hash，不追随工作树编辑。
2. 覆盖状态 pending/completed/failed/excluded 与任务执行状态分开。合法零发现只表示已读范围审查返回，不表示代码正确或测试通过。漏报分组、未读取上下文、异常 JSON 和无依据位置不得标全覆盖。
3. 精确 quote 在选定变更侧唯一匹配才产生 startLine/endLine；零匹配或多匹配保留候选及原因，删除旧侧和重命名来源保持可追溯。
4. 活动、未确认收束和历史删除互斥；模型额度、上下文额度及结果 Hash 不因重试或重启重置。上下文不足不自动扩大范围或新增调用。
5. 错误只存安全错误码，原始提供方诊断/密钥不进报告；报错/取消/重启报告保留所有计划覆盖和排除项。

## 实施顺序

- [x] 分组预算与严格结果/定位：新增 `review/inference-plan.js`、`review/findings.js`；先测超限/排除、零发现、部分覆盖、错侧、重复、唯一/多处/失效片段与异常输出，再实现。
- [x] 持久与编排：复用准备目录安全检查，新增 plan/result Hash 记录；扩展 Store 的 review 状态，新增 `ManagedReviewInference`。验证开始去重、缺配置不 claim、取消等待退出、重启不重发和报告篡改。
- [x] 原引擎接线：新增 `managed-review-plugin.js`、`managed-review-runner.js`；复用已有 RPC/进程收束，扩展 Profile 和模型 guard 的只读 review schema。使用本地模拟 adapter 验证真实 CLI/Loop 的读工具→JSON、取消/失败与无源码写入。
- [x] 路由/页面：接真实 API 的计划预览、开始/停止、覆盖报告和候选定位。合成浏览器验证完成/部分/失败状态、固定侧来源与 390×844；不启用关联修复。
- [x] 最终回归、证据与交接：npm test/check/build/test:web、真实 OCR 专项、包清单与 diff/匿名审计；同步 PRD/架构/路线/STATUS/README/验收。真实模型和 R4-3 仍另行验收。

验收结果与未覆盖项见 [R4-2 证据](INFERENCE-EVIDENCE.md)。真实模型不在本轮授权范围，R4-3/完整 R4 未完成。
