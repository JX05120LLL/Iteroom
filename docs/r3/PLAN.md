# R3 用户接受与恢复实施边界

目标是让 R2 的候选补丁在用户明确点击后可安全写回合成工作树，并在冲突或中途失败时保留可核对的状态。仍限现有选定 UTF-8 源文件的 whole-file 修改；新增、删除、重命名由后续补丁类型切片处理。

## 决策与接口

- 候选产物继续使用 R2 `version: 1`。接受器严格解析每个整文件 unified hunk，重建前后字节并与产物、快照哈希及字节数比较；不信任补丁正文中的路径或模型陈述。
- `GET /api/iteroom/managed-tasks/modify/preview?taskId=...` 返回目标文件的 `ready/applied/conflict` 和实际测试记录。`POST .../modify/accept|discard|recover` 使用已有认证载体、同源校验、8 KiB JSON 限制及 `requestId`；恢复请求另带 `mode: finish|rollback`。`POST .../history/delete` 显式删除一条已收束任务的项目外历史。
- `awaiting_review → applying → completed` 或 `discarded`；写回不确定进入 `interrupted`。每个文件先记 `pending/writing/written` 检查点，恢复可选择继续或回滚；在 `interrupted` 且有接受日志时，项目任务位保持占用。重启只把遗留 `applying` 标为 `interrupted`，不自动重放写入。
- 写回前检查**全部**目标文件，并在每个原子替换前再次核对普通文件、父目录、身份和快照哈希；结束前再检查所有文件的最终哈希。多文件不声称整体原子性。回滚只处理仍匹配本次产物后哈希的文件；外部编辑或路径异常拒绝覆盖。Git index、HEAD 和用户未选文件不由接受动作修改。
- 删除历史先将任务标记 `deleting`，再清理该任务项目外快照/产物目录并移除任务记录；清理失败保留状态供同一 `requestId` 重试。执行中、沙箱清理未确认或写回待恢复时不可删除。删除不触及项目源码。
- 任务 JSON 仍为 `version: 1`，R3 字段可选，R1/R2 旧记录按原格式读取，没有批量迁移。升级或删除历史前可在 Host 停止时备份项目外数据目录；恢复时停止 Host、还原同一项目的数据目录并核对快照/产物哈希。历史删除是明确的用户动作，需先导出要保留的候选补丁。

## 验证

采用一次性合成文件/Git 仓库，覆盖脏工作树、任务期间外部编辑、目标缺失、接受/放弃、部分写回、重启后的继续/回滚、恢复期间再编辑、历史删除以及路由同源与输入限制。运行 `npm.cmd run check`、`npm.cmd test`、`npm.cmd run build`、`npm.cmd run test:web`、包清单和 `git diff --check`；真实模型、沙箱、浏览器点击和发行分别记录，不拿一种代替另一种。

## 当前限制

本机应用层的检查与 `rename` 之间没有跨编辑器的 OS 原子 compare-and-swap；同权限进程在极短竞态窗口内修改目标仍需额外平台级机制才能强保证。恢复不会自动处理这种未知外部编辑。旧完整 DSH Web 开发入口仍有宿主工具；新接受链路只属于受管修改面板。
