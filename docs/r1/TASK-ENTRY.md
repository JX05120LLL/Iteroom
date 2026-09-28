# R1-1：受管只读任务登记

R0 已完成限定范围的技术兼容验证。本切片先让 Iteroom 拥有独立的产品任务记录和入口，仍由现有 DSH Web Connection 承载已认证的 HTTP 请求。它**不启动 DSH Session、不读取项目文件、不调用模型或沙箱**，也不替换旧文字工作台；R1 的真实代码理解与 UI 接线继续分切片完成。

## 接口与数据

- `POST /api/iteroom/managed-tasks/create`：浏览器同源、DSH Connection 已认证的请求；JSON 仅接受 `requestId`、`kind: "understand"`、`objective`、`paths`。`requestId` 为 1–100 位安全标识，`objective` 为 1–500 字符，`paths` 为 1–16 个项目相对文件路径。请求采用流式接收，在入口限制为 8 KiB；与 GET 分路径是因为固定版 Connection 以路由为单位选择流式/缓冲模式。路径不接受绝对、反斜杠、`.`/`..`、空段、`.git` 和明显凭证文件；当前仅保存选定范围，后续真实读取须再次校验文件类型与路径。
- `GET /api/iteroom/managed-tasks` 返回当前启动项目的受管任务列表；带 `taskId` 时返回单项。响应不缓存。错误返回稳定 `code`，不回显请求正文或本机堆栈。
- 成功创建返回 `201`；相同 `requestId` 和完全相同输入返回原任务 `200`，不重复登记；相同 ID 不同输入及第二个活动任务返回 `409`。只有一个启动项目，客户端不能指定其他项目路径。
- 新任务为 `queued`，`engineStatus: "not_started"`，`sessionId: null`，`executionIds: []`。`queued` 在本切片只表示登记，**不表示模型请求已排队外发或文件已读取**。没有写/执行/联网/审批接口。

新记录使用项目外 `ITEROOM_DATA_HOME/managed-tasks-v1/<projectId>.json`，与旧 `tasks/` 证据及 DSH Session 文件隔离；`projectId` 由项目真实路径哈希生成。写入使用同目录临时文件和替换、独占锁；已有锁或记录格式/项目身份异常时拒绝，不能清空旧数据或重新发起执行。`ITEROOM_DATA_HOME` 位于项目内时拒绝。当前无迁移，旧数据保持原格式可读。任务目标和范围可能包含敏感信息，文件仅保存在用户本机数据目录，不写入仓库。

## 验收与实施

1. 用合成 Git 项目创建任务，重复请求返回同一 ID；并发请求只建立一个活动任务。重建 Store 后仍能查询，第二任务被拒绝。
2. 越界/凭证路径、异常 JSON、过大输入、跨来源和缺少授权 Cookie 的请求在记录前拒绝；新入口不触发模型、Shell 或沙箱，宿主项目文件不变。
3. 记录损坏或锁未确认时失败关闭，不删除旧任务或把未知状态报告为完成。完成后运行单元、现有产品、类型和构建检查，再用实际本机 Web carrier 验证认证和路由。

接口先由 `src/host/managed-task-store.js` 管理任务持久化与串行规则，`src/host/managed-task-route.js` 处理 HTTP 输入，`src/index.js` 只负责把路由挂到现有已认证 Connection。后续 DSH 引擎接线必须显式关联 taskId/sessionId，并在实际读取前复核范围；不能把 R0 探针或旧 DSH turn 投影自动升级为本任务的执行证据。
