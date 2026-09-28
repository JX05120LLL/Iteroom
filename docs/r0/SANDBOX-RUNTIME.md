# R0 Gate C：Windows 到 Linux 的实际运行切片

2026-09-27。按用户授权的[无模型计划](OPENSANDBOX-PLAN.md)，在项目外准备固定 SDK、服务及镜像。未调用模型、读取真实配置、挂载用户项目或发送用户源码；产品启动器/UI 与依赖保持原状。本基本切片单独不关闭 Gate C，后续汇总见 [GATES](GATES.md)。

## 固定版本与部署

- Windows x64、Node 24.14.0、Docker Linux Server 29.4.0；Docker Desktop/WSL2 承载 Linux amd64 容器。
- 官方源码 `4a5619524650ff7c2cbaf59626df822fce72b161`；服务按 uv.lock 安装，Python 3.10.20，版本 `0.1.0.dev1+g4a5619524`。
- npm `@alibaba-group/opensandbox@1.1.0`，安装时忽略 scripts，完整 integrity 见[预检报告](sandbox-preflight-report.json)。不是用研究源码 manifest 代替已安装包检查。
- execd v1.1.0、egress v1.1.7、Node 24 bookworm-slim 均按下载后的 digest 固定；digest 和镜像大小见[运行报告](sandbox-runtime-report.json)。公开镜像缓存保留，不全局 prune。
- 控制服务 `127.0.0.1:3088`，随机临时 API key 只在项目外；proxy resolve_internal=false、SDK useServerProxy=true，关闭遥测导出。bridge/publish_host 回环、端口 43000–43100，空宿主路径白名单，无用户目录/源码/Docker socket 挂载。
- 实际 Docker inspect 核对 1 CPU、512 MiB、pids_limit=128、no-new-privileges、无 bind mount、容器 env 不含控制 key；采用普通 Docker runtime，未验证 gVisor/微虚拟机隔离。

Docker 初始不可用，两次启动分别暴露 Inference runtime socket 与 Secrets Engine socket 错误。诊断期间仅将 Docker 的临时 run 目录重命名备份、停止本次启动的进程；未改 Secrets Engine 数据。用户选择自行修复后，独立探针确认 Linux engine 可用才继续。该备份保留在项目外；不自动恢复运行中的 socket 目录，不重启或停止用户 Docker。

## 实际已验证

| 场景 | 证据与边界 |
|---|---|
| 分配与就绪 | 公共 adapter factory 转发真实 create，先记录拥有的分配 ID，再 wait/health；非 mock |
| 导入→修改→测试→导出 | 两个合成文件经文件 API；真实 node --test 先 exit 1 再 exit 0；下载内容与输出哈希一致 |
| 宿主未改 | 磁盘上的两份合成输入前后内容哈希一致；不读取用户仓库 |
| 参数转换 | 带单引号、中文、空格、`$HOME;` 的参数在容器内实际断言按字面保持 |
| 前台/后台取消 | interrupt 后查询 running=false，并用 /proc 核对父进程及子进程无活进程；zombie 不计为运行 |
| 命令超时 | 实际 2 秒超时保留错误/非成功终态，查询停止并核对父子进程 |
| 客户端断线 | 真正中止 SSE 后远端仍 running；显式 interrupt、查询和 /proc 核对停止，不重放命令 |
| 隔离与清理 | 资源/env/mount 实际核对；kill 后 API 404、Docker 应用与 egress 标签为空，记录过的 managed volumes 不再存在 |

只验证显式 deny-all 策略的回读，尚未证明 DNS 和直接 IP 的阻断效果；不能称为完整断网保证。每次复验只建一个应用沙箱、finally 清理自有分配。已有 Docker 容器保留，下载的 SDK/服务和镜像缓存留作复验。

## 实际契约差异

1. SDK 文件 mode 被转换为十进制字符串，而固定 execd 按八进制解析。JS `0o755` 变为 `493` 并被服务拒绝；本探针传数值 `755`/`644`（八进制数字的十进制表示）。后续产品适配须明确规范，不能沿用惯常 JS mode 常量。
2. SDK 1.1.0 类型允许 string[]，但 execd v1.1.0 拒绝 argv JSON，要求 command。探针仅在容器内把每个参数按 POSIX 单引号转换；宿主 OCR/Git/Docker 调用仍使用参数数组。真实参数测试通过不代表开放任意用户命令的权限已实现。
3. Docker 服务配置要求至少 100 个发布端口；原拟定 43000–43020 被拒绝，修正为 43000–43100。类型可用与真实服务兼容是两项证据。
4. SDK 1.1.0 的 SSE transport 在响应头返回后移除 AbortSignal 监听，后续 abort 没有中止请求；[实际失败报告](sandbox-sdk-abort-report.json)保留 client_disconnect_missing，最终 finally 已清理资源。探针通过公开 adapter factory 仅为 SSE 替换为 native fetch，仍是真实 HTTP、原认证/代理协议，无 mock 或上游包修改。再实测客户端中断后命令仍在运行，必须另行 interrupt；不能把 Abort 当远端取消。

## 复验与剩余项

复验需要项目外 `iteroom-r0-sandbox-*` 安装目录，包含已锁定 SDK、venv、带随机 key 的 r0.toml、r0-key 和 images.json，且该临时控制服务已在回环 3088 运行。配置依据 [计划](OPENSANDBOX-PLAN.md)，完整私有配置不提交；启动服务须使用 `controlledEnv` 白名单环境与显式本机 Docker named pipe，不能继承模型凭证。

本切片结束时临时服务已停止，[清理报告](sandbox-cleanup-report.json)记录宿主 3088 无监听、无本次应用容器、原 4 个容器状态保留；另有其他会话创建的 1 个容器未碰。Docker Desktop、镜像缓存和隔离安装根仍保留。下一次必须重新核对，不沿用早先 ready_for_poc 的服务判断。

```powershell
$env:ITEROOM_SANDBOX_POC_ROOT = '项目外受管安装目录的绝对路径'
node scripts/r0/sandbox-preflight.mjs
# 仅在本次无模型沙箱授权范围内设置；会实际创建/执行/删除合成沙箱。
$env:ITEROOM_R0_SANDBOX_EXECUTE = '1'
node scripts/r0/sandbox-runtime.mjs
node --test test/r0-sandbox-preflight.test.js test/r0-sandbox-runtime.test.js
```

若复用已核验的隔离安装，在另一个终端以受控环境启动临时服务（先确保 3088 空闲，设置上述安装根与执行授权标志）：

```powershell
node --input-type=module -e 'import{spawn}from"node:child_process";import{controlledEnv}from"./scripts/r0/ocr-process.mjs";import{validatePocRoot}from"./scripts/r0/sandbox-preflight.mjs";if(process.env.ITEROOM_R0_SANDBOX_EXECUTE!=="1")throw Error("not authorized");const root=await validatePocRoot(process.env.ITEROOM_SANDBOX_POC_ROOT);const child=spawn(root+"/venv/Scripts/opensandbox-server.exe",["--config",root+"/r0.toml"],{cwd:root,windowsHide:true,env:{...controlledEnv(root+"/home"),DOCKER_HOST:"npipe:////./pipe/dockerDesktopLinuxEngine",OTEL_SDK_DISABLED:"true",OPENSANDBOX_DISABLE_METRICS:"1"},stdio:"inherit"});child.on("error",()=>process.exitCode=1);child.on("exit",code=>process.exitCode=code??1);'
```

服务日志只留在本机。结束后按该启动时间、安装路径和进程链核对归属，停止自己的服务并检查 3088；不能按 Python 名称批量结束进程。

未设置授权标志直接拒绝执行；预检不创建资源，不能当 Gate C 完成。SDK/服务/Docker 不可用时保留失败或 unavailable。匿名报告不含 key、本机路径、源码、命令正文或原始沙箱/执行 ID。

后续[生命周期/网络切片](SANDBOX-FAULTS.md)补齐 TTL、临时控制服务重启后的执行状态、可恢复清理失败、公开 IPv4 DNS 与同 IP TCP 正向对照；限定环境内 Gate C 通过，边界见 [Gate 汇总](GATES.md)。本运行报告保留切片当时未完成含义。[DSH 工具组合](DSH-SANDBOX.md)补齐模拟模型与实际沙箱的调用、取消及结束/取消会话重启；Gate A 仍缺真实模型，另须提供方、次数与费用授权。UI/浏览器、发行和 v1 产品验收未复验。
