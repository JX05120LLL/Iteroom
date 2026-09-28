# R0 真实模型调用前的传输约束

真实模型缺用户授权/路由/凭证/费用上限，不能完成 Gate A。此切片只做本机合成 HTTP/SSE 与已有固定官方 adapter 的契约检查，无凭证读取、外网请求、沙箱部署或产品入口变化。

- [x] TDD：未授权不触达 transport；模型/端点/输出/字节/文本数据范围；最多六次，失败/取消不返还；持久记录先于 transport，写失败停止；重启计数与并发保留。
- [x] 实现独立 fetch guard，只接受固定端点 POST chat/completions，无自动重定向或请求字段扩展；沿用 AbortSignal。持久化由调用者提供，不伪装产品预算存储已实现。
- [x] 用固定公开 DeepSeekAdapter/resolveAdapterOptions，对自己启动的回环服务核对真实 HTTP/SSE、输出上限、thinking disabled、错误码与请求次数。只用合成标记，无真实 key；这不是提供方选择或真实推理。
- [x] 独立审查、相关检查、匿名报告与文档同步。真实模型需获授权后接实际路由与私有持久记录；费用换算待模型和计价确定，不用请求上限当金额上限。

Ruling：先核对已有官方 DeepSeek adapter 的协议，不据此默认选择 DeepSeek。其他提供方/模型要按用户回复重新验证；本机协议通过不关闭 Gate A，不扩大原无模型授权。

审查记录：0 Critical / 2 Important / 1 Minor。连接器透传及嵌套工具结构两项Important先补失败测试，再修正并8/8通过；仅一次修正，不重复审查。Minor（报告wire校验只保留最后一次）留在MODEL-TRANSPORT限制，逐次请求守卫不受影响。真实模型、磁盘原子日志与金额约束不在本切片完成范围。
