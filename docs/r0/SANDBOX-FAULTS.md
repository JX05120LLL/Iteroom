# R0 OpenSandbox 生命周期与网络实测

2026-09-27。沿用已批准的无模型沙箱范围，只传合成代码，不读取用户源码或凭证。版本、安装和镜像见 [基本运行切片](SANDBOX-RUNTIME.md)；产品 UI、启动器和依赖没有切换。

## 实际证据

[匿名故障报告](sandbox-faults-report.json)记录以下实际行为，执行 ID、输出和公共目标 IP 仅保存哈希：

| 场景 | 实测与通过条件 |
|---|---|
| 网络策略 | 实际 status=ok / enforcementMode=dns+nft；deny 下 example.com IPv4 DNS 失败，仅允许该域名后 DNS 和同 IP TCP 443 成功，撤销规则后同 IP TCP 失败。正向对照避免把外网不可用当作策略生效 |
| 控制服务重启 | 仅停止自己启动且 PID、启动时间和配置路径匹配的临时服务；重新启动，通过公开 Sandbox.connect 核对原执行仍运行、启动标记只有一次，再显式 interrupt。不重放命令 |
| 可恢复清理失败 | 控制服务关闭时实际删除请求失败，Docker 中原资源仍在；恢复该服务后重试，API 404 且应用/egress 容器及已记录卷消失 |
| TTL | 固定服务至少接受 60 秒 TTL；后台命令超时为 120 秒，临近到期再次核对 running 和父子 /proc 存活。未主动 kill，等待 API 404，再等待两个容器和已记录卷全部回收 |
| 服务收束 | 成功后停止自己的控制服务，核对 3088 空闲；每次最多两个串行应用沙箱，峰值同时运行数为 1 |

网络证据仅覆盖该公开 IPv4 目标的 DNS 与 TCP 443，不外推到 IPv6、任意协议/目标、宿主端点或完整安全隔离。清理失败注入是控制服务不可达，未注入 Docker daemon/存储永久删除失败。服务重启验证的是执行查询和不重放，不是进程暂停/恢复或产品任务恢复。

## 失败保留与处理

- [创建超时报告](sandbox-create-timeout-report.json)：5 秒客户端等待曾超时，但服务实际完成了分配。后续按本次 owner 核对并回收两个合成分配，API、容器和卷均确认删除。客户端没有返回 ID 不等于没有资源。
- 创建前持久化 owner 与 allocationPending。结果未知时，即使暂时没查到应用容器，也不能排除正在创建 egress/卷。保留控制服务与待核对日志，不宣称清理完成；下一次探针遇到未确认日志直接拒绝启动。不得按全局标签或名称清理未知资源。
- [TTL 契约失败报告](sandbox-ttl-contract-report.json)：30 秒 TTL 被拒绝；改用 60 秒。API 404 可能早于 Docker 回收完成，不能仅凭 404 报告删除成功。
- 离线测试覆盖 PID 归属、端口占用、授权拒绝、网络降级/失败对照、弱 TTL 证据、未确认分配/清理及 owner 校验。延迟分配保守判定是离线测试，不冒充实际竞态注入。

## 复验

先核对固定安装、Docker Linux engine、3088 空闲和项目外归属日志。以下命令自行启动/停止自己的临时服务；不能同时运行依赖 3088 的其他探针，也不能复用其他会话服务。

```powershell
$env:ITEROOM_SANDBOX_POC_ROOT = '经核对的项目外受管安装根'
$env:ITEROOM_R0_SANDBOX_FAULTS = '1'
node --test test/r0-sandbox-faults.test.js
```

直接探针命令为 node scripts/r0/sandbox-faults.mjs。只有取得本次沙箱授权后才设置执行标志；离线检查先移除该标志，会明确跳过实际集成项。安装根内的 key、配置、资源日志与诊断留在本机，不提交。未确认资源须先依据归属核对，不能清空日志后再次启动探针。

## Gate 边界

结合基本运行和本报告，Gate C 路线要求在固定 Windows 宿主→Linux Docker、受管合成输入与上述故障/网络范围内有实际证据。原始报告的 gateC=not_completed 表示各自切片不单独关闭 Gate；整体核对见 [Gate 汇总](GATES.md)。

后续[DSH 工具组合](DSH-SANDBOX.md)已验证模拟模型与实际沙箱工具的循环、取消及结束/取消会话重启；Gate A 仍缺真实模型验证。R0 与 v1 未完成，A01–A21 产品验收、真实源码、浏览器和发行未据此更新为通过。
