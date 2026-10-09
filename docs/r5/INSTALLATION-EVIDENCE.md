# R5-2 独立安装与缺配置恢复

2026-10-09 · 交付父提交 `daafd60` 已推送 `origin/main`；本切片开发时有未提交改动，报告的 parent 是验证父基线，最终提交以 Git 为准。R5-2 是 Windows 本机的独立消费项目验证，**R5 / 全部 P0 / v1 未完成**。

## 安装与运行范围

`scripts/r5/install-smoke.mjs` 在本次独有 TEMP 根内 npm pack、创建消费 package、安装生产依赖，再从已安装的 `bin/iteroom.mjs` 启动合成 Git 项目。不链接源码目录 node_modules，不在消费目录构建，包内 44 个文件逐个与构建结果核对 Hash；DSH 实际从消费目录解析。检查 `.bin/iteroom.cmd` 存在，实际调用 Node launcher；cmd shim 调用本身未验。

初次 `--offline` 缓存缺失，安装失败并收尾；获本次开发范围授权后，以官方 registry 补齐公共包，禁用 lifecycle scripts/audit/fund，再离线复验。554 个实际依赖目录及版本、消费锁 Hash 见报告；传递依赖仍受上游范围控制，不承诺与源码 checkout 的锁图完全相同。新消费目录仍使用这台机器的 Node/npm、缓存和 Chromium，**不是空缓存或全新机器发行**。

真实已安装 API 验证未认证 401、外来源 403、运行预算及缺配置提示；理解启动返回 `MODEL_NOT_CONFIGURED`，修改启动返回 `SANDBOX_NOT_CONFIGURED`，均保持 queued / not_started / 无 Session，取消后释放项目。真实生产 Chromium 390×844 检查白色方案 C、缺配置沙箱检查按钮禁用、无横向溢出，以及页面创建理解任务 → 开始被拒绝 → 取消 → 可再次创建任务。

8 个合成源文件 Hash、Git HEAD/index/status 不变，模型 guard 请求 0，实际沙箱分配 0；未读取/发送用户源码或复制私有凭证。验证环境会移除继承的模型/沙箱相关变量并使用独立数据根，旧完整 Web carrier 依然保留原入口和工具。

## 验证发现并修复

- 缺少模型配置后，queued 理解任务原先不能取消，持续占用项目。新增取消动作与 UI 按钮；任务没有启动时不伪造 Session。
- 取消与快照准备有两个先后顺序：已开始的准备必须收束；正在取消时必须阻止新启动。同步记录 starting/cancelling，取消等待准备及引擎停止；claim 中取消只结算逻辑收据。重复启动共享同请求准备，dispose 等待所属操作。离线门闩回归验证删除历史后快照不会重新出现。
- 活动任务存在时删除旧历史原会写出两个活动状态，使冷读失败。现在锁内返回 `HISTORY_ACTIVE`，原记录字节不变；结束活动任务后可重试删除。
- 浏览器 open 失败仍可能创建 session。独立资源 helper 在尝试前记录归属；异常仍关闭，未确认关闭则报告失败并保留 TEMP。partial-open / close-failure 是离线 stub 回归；最终正常浏览器报告另记实际关闭结果。
- 既有审查取消测试的 30ms 定时断言在全量并发时失败；改为等待实际 abort 信号，再检查 cancelling，仍保持引擎释放前不能结算的断言。产品审查实现未改。

## 匿名记录

最终全量 `npm.cmd test` 为 **140 项：139 通过、1 Windows Git 执行位条件跳过、0 失败**；固定真实 OCR 集成没有缺工具跳过，check/build/test:web 通过。取消/历史/浏览器资源专项 15/15；生产浏览器运行真实已安装代码，模型服务未请求，沙箱未分配。首次全量 134 项中的审查取消定时断言失败与后续修正区分记录，不以局部绿色代替最后结果。

- [最新安装与生产浏览器报告](installation-final-2026-10-09-report.json)、[390px 截图](installation-final-2026-10-09-status-390.png)：最终脚本/资源 helper/客户端 Hash、消费版本清单及关闭结果。
- [启动后故障收尾报告](installation-fault-2026-10-09-report.json)：真实已安装 Host 启动后注入失败；success 保持 false，只有所属进程退出、服务停止和 TEMP 删除全部确认才记录 expectedFailureCleanupPassed。
- [交付检查汇总](installation-delivery-2026-10-09-report.json)：最终源码/构建 Hash、相关与全量测试、构建/Web/静态检查。
- 失败记录保留：[离线缓存缺失](installation-2026-10-09-report.json)、[首次安装后取消缺陷](installation-registry-2026-10-09-report.json)、[页面取消入口缺失](installation-ui-red-2026-10-09-report.json)。[早期 GREEN](installation-green-2026-10-09-report.json)先于准备竞争与脚本清理修正，不能替代最终报告。

原始 npm / token URL / 浏览器异常仅留本机项目外私有诊断，不进入仓库；公开报告只有版本、Hash 和匿名结果。

## 兼容、备份与回退

没有自动迁移或删除用户数据，旧 v1 记录仍可读。新产生的理解取消记录为 `cancelled + not_started + sessionId=null`（可已有完成的快照），旧版验证器可能拒绝这类状态。

1. 升级/降级前停止相关 Iteroom 服务，备份完整 `ITEROOM_DSH_HOME` 或默认 `%LOCALAPPDATA%\Iteroom\harness` 至另一个项目外目录；同时备份自定义数据位置及所需导出产物。
2. 先确认新版本能冷读旧任务，再生成新记录。降级时优先恢复升级前备份；若需保留升级后内容，先在新版本导出所需产物、结束所有活动任务，再逐项显式处理新取消历史及旧版不认识的 review 等记录，不能批量清空数据。
3. 在备份副本的独立数据目录复验旧版，核对读取及范围后再切换。恢复整份备份会失去备份后的记录，保留当前副本以便回滚；不要把凭证或源码备份提交 Git。

本轮只测试合成目录的冷读与删除，没有操作真实用户数据或承诺完整历史导出/恢复功能已完成。

## 复验

在仓库根执行（工具路径须指向本机已有安装）：

```powershell
npm.cmd run check
npm.cmd run build
$env:ITEROOM_OCR_BIN = '<经 Hash 核对的官方 Windows x64 v1.12.9 可执行文件>'
npm.cmd test
npm.cmd run test:web
$env:ITEROOM_PLAYWRIGHT_CLI = '<已有 Playwright CLI 的绝对路径>'
node scripts/r5/install-smoke.mjs installation-retest
node scripts/r5/install-smoke.mjs installation-fault-retest --fail-after-start
```

默认离线，缺包时会失败；`--online` 只在允许下载公共依赖时添加。使用新 evidence stem 保留历史。脚本仅清理本次归属已确认的根/进程/session，关闭未确认时失败并保留资源线索。

## 未验与下一步

见 [支持矩阵](SUPPORT-MATRIX.md)。首次有效凭证配置、已安装版本的真实理解/沙箱修改/审查完整演示、空缓存新机器、Node 22/Linux/macOS、cmd shim、发行许可/归属及升级安装未验。下一切片先设计新增/删除/重命名补丁的版本化快照、工具、导出、接受恢复协议，行为测试和兼容策略通过后接实际沙箱；不因 OCR 能审这些类型便称已能修改。
