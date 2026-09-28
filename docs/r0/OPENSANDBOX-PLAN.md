# R0 Gate C / Gate A 真实验证准备

2026-09-27。用户已授权无模型沙箱验证；实际证据见 [运行切片](SANDBOX-RUNTIME.md)与[生命周期/网络切片](SANDBOX-FAULTS.md)。Gate C 限定环境收口见 [Gate 汇总](GATES.md)；Gate A 真实模型授权仍独立，本计划不是 R0/v1 完成声明。

**后续状态（2026-09-28）：** 用户另行授权最多 6 次、5 元费用上限的合成真实模型验证；[实际 Gate A 结果](DSH-LIVE.md)为 3 次请求通过。三个 R0 技术 Gate 在限定范围内收口，v1 仍未完成。本页其余内容保留为实施前计划，不代表新的模型调用授权。

## 已核对前提

- 初始 Linux engine 不可用；Docker 启动失败后用户选择自行修复。后续实际预检为 Docker Server 29.4.0，已创建合成沙箱；服务异常历史及保留备份见运行切片。
- WSL 列出 Ubuntu-22.04 与 docker-desktop；Python/uv 可定位。这不证明 OpenSandbox 能在 Windows 启动。
- 项目外已有官方源码快照 `4a5619524650ff7c2cbaf59626df822fce72b161`，server 配置和 TypeScript SDK manifest 已重新核对。SDK 源 manifest 版本 1.1.0，不把源码版本当作已安装 npm 包。
- server 示例为回环 8080/bridge，execd v1.1.0、egress v1.1.7；实施时须验证可取得镜像及 digest，不能仅固定可变 tag。

## 授权后执行的 Gate C 范围

1. 启动本机 Docker Desktop（影响：Linux engine 与其既有容器可能启动）；先清点已有容器，不停止或清理用户资源。
2. 在项目外独立目录准备固定源码服务及 SDK，不改全局 Python/npm 和产品依赖；安装公开依赖、拉取镜像会联网并占用磁盘。
3. 独立控制服务绑定 `127.0.0.1:3088`（端口占用则停止并报告），生成仅临时使用的随机 API key，关闭 SDK/服务遥测导出，不读取真实配置或凭证。
4. 显式 bridge、publish_host=127.0.0.1、allowed_host_paths=[]、无 sandbox_binds；drop capabilities/no_new_privileges，单沙箱 1 CPU/512 MiB、TTL 最多 10 分钟，串行最多两个应用沙箱。进程上限 128；不挂载源码、用户目录或 Docker socket。
5. 合成 Node 项目只含几个小文件，无 npm install。创建→Pending→实际健康/就绪→上传→修改→node --test→下载并校验哈希→删除→API 与 Docker 双重核对。
6. 命令成功/失败、前台/后台及子进程取消、客户端断线、TTL、仅该临时控制服务的重启、可恢复清理失败逐项验证。记录命令执行 ID 与终态，未知副作用不重放。
7. 配置显式拒绝联网策略，分别探测 DNS 与直接 IP；后端不支持或降级则记录并拒绝需要该能力的任务，不以 DNS 拦截推断全网络隔离。
8. 结束时仅清理本次 API 分配且 Docker 归属核对一致的容器/卷/网络，以及自己创建的临时服务进程；不停止 Docker Desktop或其他服务。公开镜像缓存保留，不执行全局 prune。

拟定关键配置（完整可运行配置与镜像 digest 在部署前校验）：

```toml
[server]
host = "127.0.0.1"
port = 3088
max_sandbox_timeout_seconds = 600
# API key 使用临时受管配置，禁止写入仓库；不得启用 insecure server。
[proxy]
resolve_internal = false
[runtime]
type = "docker"
[storage]
allowed_host_paths = []
[docker]
network_mode = "bridge"
publish_host = "127.0.0.1"
port_range_min = 43000
port_range_max = 43100
no_new_privileges = true
pids_limit = 128
```

Windows 到 Linux 的控制/端点可达性必须实测；不能为了绕过失败改用 host 网络。实际资源/认证/网络限制还需 SDK 请求与服务检查，以上片段不构成完整安全配置。

## Gate A 真实模型范围（单独授权）

- 仅验证固定 DSH 推理→自有只读/沙箱工具→工具结果→下一步、错误/取消、持久化与重启，沿用公开 Profile/Patch 与 Agent 接口，不复制 Loop。
- 正常循环预计 2–3 次请求，失败/取消复验最多总计 6 次；输入只含合成代码（约 20 行）、工具 schema 和探针指令，单次输出上限 256 tokens，不传用户源码或原有会话。
- 提供方、模型、凭证位置由用户指定；不通过聊天收集 key，不自动读取已有 DSH 私有配置。费用以选定提供方计价，模型确定后才能给出预算，超过批准次数/预算即停止。
- 未获授权不发送任何请求；真实模型证据与模拟模型报告分开保存。

## 完成条件

Gate B 独立收口不代表 R0 完成。Gate A/C 的每条 [ROADMAP](../ROADMAP.md) 要求都需要对应真实运行证据、固定版本、限制和复验命令；环境前提不足时保留 unavailable/unsupported，mock 不能补齐。现有 UI、启动器和用户数据保留，不提交/推送，不提前实施 R1/R2。

来源为上述固定官方源码中的 server 示例/config、Docker service 和 SDK；不会用研究文档替代运行证据。
