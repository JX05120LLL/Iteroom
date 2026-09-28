# R0 Gate 核对

2026-09-28，基于当前未提交工作区与匿名运行报告。**R0 三个技术 Gate 在固定版本、Windows 宿主与受管合成输入范围内完成**；不是远程 CI、产品 A01–A21 或 v1 完成声明。版本与复验入口见各切片，升级版本需重新验证。

| Gate / 路线要求 | 证据 | 结论及范围 |
|---|---|---|
| A：固定 DSH/Cordis、受支持启动、工具挂载 | [契约](DSH-CONTRACT.md)、[运行](DSH-RUNTIME.md) | 固定 DSH 0.1.5-rc.3/Cordis 4.0.2，实际官方 Profile/Patch CLI；宿主执行插件禁用，自有内存只读工具已调用 |
| A：真实模型 → 自有工具 → 实际沙箱 → 下一步 | [真实组合](DSH-LIVE.md)、[匿名报告](dsh-live-report.json) | 官方 deepseek-flash 3 次真实请求；内存只读工具与沙箱修复/Node 测试各执行 1 次，模型收到结果继续；Session 重启历史保留且远端动作/模型请求未增加，宿主输入未变，本次资源清理。**Gate A 在固定环境/合成输入内通过**，不代表产品接线或服务方费用硬上限 |
| A：错误、拒绝与取消 | [只读模拟模型](dsh-runtime-report.json)、[实际沙箱组合](dsh-sandbox-report.json)、[本机传输](MODEL-TRANSPORT.md) | 实际 DSH + 模拟模型 + 真实沙箱；远端退出 7、guard 拒绝、Agent.cancel/whenIdle 及父子停止，结束/取消 Session 重启不重放；回环 HTTP/SSE 401 与 Abort。真实提供方故障/流取消及崩溃中未知副作用未验，不外推 |
| B：三种输入、JSON、规则与覆盖 | [Delegate](OCR-DELEGATE.md)、[输入](REVIEW-INPUT.md) | 固定 OCR v1.12.9 Windows x64；工作树/提交/范围与实际 Git 比对；测试纳入、删除旧侧待推理、binary/provider 排除；未调用模型 |
| B：固定副本、历史与异常边界 | [固定副本](FIXED-REVIEW-COPY.md)、[报告](ocr-fixed-input-report.json) | 独立 objects/index/字节，源后续改动不影响 CLI；保守拒绝 attributes/filter/外部存储、多祖先等；进程/超时/JSON/输出/路径测试通过。**Gate B 限定环境内通过**，非产品原子快照、非恶意仓库支持 |
| C：创建/就绪/导入/修改/测试/导出/删除 | [实际基本链路](sandbox-runtime-report.json) | Windows 宿主→Linux Docker 29.4.0；SDK 1.1.0，服务源 4a5619524，digest 镜像；合成输入与真实执行，宿主输入未变 |
| C：前台/后台父子取消、超时与断线 | [运行限制](SANDBOX-RUNTIME.md) | 远端执行查询 + 父子 /proc 核对；SDK SSE Abort 缺陷以公开 factory/native fetch 实际绕行，断线仍运行需显式 interrupt，不重放 |
| C：TTL、服务重启、可恢复清理失败 | [故障报告](sandbox-faults-report.json) | 到期前 8.864 秒父子仍活，命令超时 120 秒 > TTL 60 秒，未主动 kill；API 404 后等待容器/卷；控制服务重启后原执行/启动次数核对，服务不可达删除失败后恢复重试 |
| C：网络、资源、挂载、凭证与降级 | [生命周期/网络](SANDBOX-FAULTS.md)、[基本链路](sandbox-runtime-report.json) | 实际 1 CPU/512 MiB/pids128、无 bind/控制 key；example.com IPv4 DNS 与同 IP TCP 443 的拒绝/允许/撤销对照；不支持/降级拒绝另有离线测试。**Gate C 限定环境内通过**，非全部协议/宿主端点或生产安全验收 |

[模型传输准备](MODEL-TRANSPORT.md)8/8（7离线+1本机真实HTTP/SSE）在该切片当时仅验证固定公开适配器与请求约束；本次真实组合另见上表。报告 wire 字段是最后一次观察，守卫逐次校验。

[私有磁盘计数](MODEL-JOURNAL.md)7/7 覆盖受管文件与独立 Node 进程的提交/重开/锁和实际写失败，以及锁初始化 I/O 注入；后续已接入[真实组合](DSH-LIVE.md)，仍不是产品预算存储或服务商硬消费限额。

Gate C 由基本链路和故障两份报告共同支持。历史报告中的 gateC=not_completed 保留切片当时的含义，不回写成单份报告覆盖整个 Gate。创建超时和 TTL 30 秒拒绝的失败报告也保留，不只展示成功结果。

本轮故障测试 8/8（7 个离线边界 + 1 个实际综合集成）；此前分别执行 DSH/OCR 66/66、沙箱基本链路 7/7。不是一次全量 81 项运行。npm test 只包含既有产品测试；真实项缺安装/授权时 skip/unavailable 不能补齐 Gate。

后续 DSH/实际沙箱无模型组合复验 11/11；真实组合另外一次 3 请求通过，模型费用批准上限 5 元、本地规划上界约 2.691072 元，未核对服务商账单。相关离线/回环/DSH 测试本轮 44 通过、1 个未启用的实际沙箱集成跳过；该集成已单独显式运行 11/11。固定真实 OCR CLI 回归另为 49/49；各轮证据分开，不合并成一次全量运行。R0 技术兼容验证已收口；下一阶段 R1 产品 Host 尚未开始，A01–A21、浏览器和发行未完成，UI/旧入口保持原样。
