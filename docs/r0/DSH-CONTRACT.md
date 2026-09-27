# R0 · DSH 离线契约与配置合成验证

2026-09-27；这是 R0 Gate A 的第一个切片，Gate A/B/C 均未完成。

## 本轮结果

在 Windows / Node.js 24.14.0、工作区提交基线 b9e3c47 上执行，已有未提交改动全部保留。新增工具不改变现有 Web 入口，不启动产品 Agent，也不访问真实项目代码、模型凭证或沙箱。

- DSH 0.1.5-rc.3、Cordis 4.0.2 以及所检查的 8 个核心包版本一致。
- 公开导出中的 Context、defineTool、工具注册及 Agent Loop 注入契约符合本切片要求。没有使用内部 scheduler。
- 通过真实官方 CLI 执行 `--profile sdk-minimal --dump-default-config` 与 `--patch ... --dump-config`。临时 workspace 与 DSH_HOME 独立于用户目录；CLI 不启动应用、不求值 `!!js`。
- 默认配置有 31 行；9 个宿主执行/策略/终端配置项存在或按平台条件启用。特别是持久 Shell 与 danger-full-access 默认策略，不能直接当作 Iteroom 隔离模式。
- 临时 Patch 显式禁用这 9 项。CLI 合成后的配置仍包含本切片要求的核心服务，不再有未禁用的已识别宿主执行提供方或工具插件。
- 候选配置仅用于下一轮启动验证：禁用提供方可能影响其他插件注入，**当前没有证明应用能成功启动或工具执行策略可用**。

匿名 JSON 证据见 [dsh-contract-report.json](dsh-contract-report.json)。文件只保存公开包/配置 ID、版本、环境与检查状态，不保存 CLI 配置正文、目录、Key 或源码。报告中的 `gateA: not_completed` 和 `appBooted: false` 是有意保留的边界。

## 复验

在仓库根目录：

```powershell
node --test test/r0-dsh-contract.test.js
node scripts/r0/dsh-contract.mjs
npm.cmd run check
npm.cmd test
```

工具使用现有 DSH 的 js-yaml 解析器，无新增依赖。`!!js` 保存为未执行标记；未知启用条件不算“已禁用”，未知核心启用条件也不算“已就绪”。异常结构、重复 ID、超限输入、未知 YAML tag 和版本漂移均失败。固定配置中不认识的插件也必须先复核，不能仅因包名未匹配 Shell 黑名单就放行。

本次检查：R0 测试 9/9 通过；类型检查通过；原有测试 19 通过、1 个 executable-bit 场景因 Windows 能力跳过，无失败。原有测试不含新 R0 文件，需单独运行上面的 R0 命令。未重新构建/做浏览器验收，因为未修改产品源码或界面。

## 下一切片

先在同样的受管临时目录验证禁用覆盖配置真实启动；梳理 SDK 启动/事件与核心服务的关系，注册一个 Iteroom 合成只读工具，使用模拟模型验证工具循环、错误和取消。启动检查不读取用户凭证，不测试真实模型。

后续运行切片已完成这些模拟检查与已结束会话的核心恢复，详见 [DSH-RUNTIME](DSH-RUNTIME.md)。本文件及第一份 JSON 保留当时仅配置检查的证据边界，不将其倒写成运行结果。

随后分别完成 OCR Delegate 的受管 Git 输入/JSON 契约与实际 OpenSandbox 创建/执行/取消/回收。真实模型请求、远端数据传输、Docker 服务配置及真实沙箱证据按相应阶段边界说明，不能用本报告代替。
