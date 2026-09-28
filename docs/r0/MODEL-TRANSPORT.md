# R0 模型请求约束与本机协议准备

2026-09-27。用户已指定 deepseek-official / https://api.deepseek.com / deepseek-flash 并要求保存项目外配置；真实调用授权与费用上限仍待回复。本切片不读取旧配置或凭证、不发送外网请求、不部署沙箱、不更换产品入口和依赖。固定已安装 DSH 0.1.5-rc.3 的公开 DeepSeekAdapter/resolveAdapterOptions 对本次启动的回环 HTTP 服务做协议验证，不表示选择 DeepSeek 提供方。

## 请求约束

scripts/r0/model-request-guard.mjs 是独立 fetch 边界，必须由调用者显式传入授权状态、固定 baseURL/model、transport 和 commit。未授权在触达 commit/HTTP 前拒绝，不自动读取环境凭证或提供外网 CLI。

- 仅固定 POST chat/completions，不自动重定向。最多六次、每次 max_tokens 不超过 256，UTF-8 JSON 请求不超过 64 KiB；thinking 必须 disabled。
- 消息内容限文本，拒绝图片/文件内容及未允许的顶层字段（含上游 session log/plugin inventory 扩展）。工具仅允许已有两个合成探针名称；嵌套调用、参数和 schema 按固定字符串参数结构校验，拒绝图片对象、$ref 和扩展字段，不开放宿主 Shell。
- fetch init 仅接收 method/body/headers/signal，重建请求，不透传 dispatcher 或 redirect。header 限官方适配器所需字段，拒绝 Host/Cookie/Proxy-Authorization 和未知字段；这不证明 transport 实现本身可信。
- 并发请求先串行预留次数并 await commit，之后才能进入 transport。失败、超时和取消后不返还预留；第七次拒绝。已中止而尚未预留的请求不占次数。
- commit 失败后本进程 fail closed，不再调用 HTTP；回读计数须匹配固定路由/模型/限额 identity，防止改变配置后误复用记录。

这是请求形状/计数守卫，不是授权来源认证、源码过滤器或金额预算实现。调用者仍须落实用户授权、只用固定合成输入、新的受管 DSH_HOME，以及私有持久记录。单元测试用回调/保存状态模拟 commit 与回读，没有证明跨进程的磁盘原子性/并发锁。后续[独立磁盘切片](MODEL-JOURNAL.md)验证了受管文件和独立进程，不回写本报告为磁盘证据。金额上限不能从次数或输出 token 上限推导；模型计价、输入 token 与可能的附加费用在选定路由后另核对，不能先启用付费执行。

## 本机实际 HTTP/SSE

[匿名报告](model-transport-report.json)为固定官方 adapter 对动态回环端口的 **3 次合成 HTTP**：

1. text SSE 正常解析并结束；实际 wire max_tokens=128 / thinking disabled。
2. 合成 401 保持 AUTH，不隐式重试或返还请求次数。
3. 合成 SSE 等待中 Abort 保持 ABORTED，已预留次数为 3；停止本机服务之前观察客户端断线。只证明本机传输结束，不证明真实提供方停止推理或不计费。

报告的 boundedOutput/thinkingDisabled 目前只保留最后一次 wire 观察，不是三次逐项快照；所有发送前仍逐次执行守卫的输出上限与 thinking 校验。此报告粒度问题记为后续 Minor。

请求使用固定非凭证标记，没有读取 key；临时替换只发生在独立探针进程的 global fetch，finally 恢复并停止自己启动的回环服务。报告只含检查/次数/哈希，不含消息、header、原始响应或私有路径。

当前 **8/8**：7 离线守卫测试 + 1 本机真实 HTTP/SSE 集成。不是模型推理、真实提供方、产品预算存储或 Gate A 完成证据。

## 复验与后续

```powershell
node --test test/r0-model-request-guard.test.js
node scripts/r0/model-transport-probe.mjs
```

以上没有真实模型开关，只连接本次回环服务。提供方/模型/项目外凭证位置已由用户指定，实际请求仍需批准最多六次及费用上限；已有 [OPENSANDBOX-PLAN](OPENSANDBOX-PLAN.md) 的合成范围保持。按用户指定模型验证公开适配器，并接已验证的私有计数记录及待实现的金额约束后，才运行真实工具循环、错误/取消和会话恢复；真实与本机报告分开。Gate A/R0/v1 未完成，见 [Gate 核对](GATES.md)。

后续状态：2026-09-28 已按另行授权完成[真实模型/DSH/沙箱组合](DSH-LIVE.md)。上面的“待批准/未完成”描述本切片当时的状态；本机回环报告仍不替代真实报告。
