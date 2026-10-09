# R5-3 四种文本补丁契约

本切片为独立、纯数据 v2 契约与离线验证；v1 的快照/产物/接受流程保持原行为，产品尚未允许新增、删除或重命名。模型、实际沙箱、用户项目与真实写回未验，不标记 A05/A14/A15 或 R5/v1 通过。

## 数据与权限

`definePatchScope(taskId, entries)` 固定最多 16 个获准相对路径。条目为 `{path, writable, before}`；before 必须明确为 `{kind:'absent'}` 或 `{kind:'file', mode:'100644', sha256, byteLength}`。不存在与零字节文件不同。排序后的完整清单（包括 writable）关联 taskId，SHA-256 作为 id；将来由可信 Host 捕获、持久化并按任务核对，模型不能自报清单扩大权限。

路径复用现有 modify 输入校验：ASCII 相对路径、240 字符上限、无 Windows 设备名/敏感路径/越界/反斜线。再拒绝大小写别名、路径前缀碰撞。测试目录、`__tests__` 与 test/spec 文件只能 readonly；链接、硬链接、二进制、文件权限变化、目录操作和依赖安装不在本协议内。纯契约不能证明磁盘上没有链接，未来 Host 须复用真实路径与文件身份检查；新增目标的父目录必须已存在且安全。

`createPatchCandidate(scope, changes)` 接受 `{kind, old, new}`；有侧为 `{path,text}`，无侧为 null。只能 added、modified、deleted、renamed；新目标必须事先获准且 before=absent，旧侧内容必须匹配固定哈希。rename 可伴随内容修改，但拒绝同路径、仅大小写变化、交换、链式重命名、重叠端点和文件/目录转换。modified 相同字节拒绝；纯 rename 允许相同字节。所有修改端点须 writable，readonly 未变化条目仍属于冲突检查范围。

每侧文本最多 256 KiB，严格 well-formed UTF-8 字符串、无 NUL，总侧文本最多 1 MiB；补丁最多 1 MiB，完整候选 JSON 最多 2 MiB。旧/新侧保存 path/text/mode/sha256/byteLength。统一 diff 由 Host 生成、`sha256` 绑定补丁；`validatePatchCandidate` 严格核对字段、taskId/scope id、元数据与完全重建的补丁，返回规范化副本。不能将外来任意 diff 交给 Shell 执行。

## 四种操作

| kind | 固定输入 | 最终状态 | 受控步骤 |
|---|---|---|---|
| added | 目标不存在 | 目标为新字节 | create（不可覆盖） |
| modified | 原路径为旧字节 | 原路径为新字节 | replace（重核旧字节） |
| deleted | 原路径为旧字节 | 原路径不存在 | remove（重核旧字节） |
| renamed | 原路径为旧字节、目标不存在 | 原路径不存在、目标为新字节 | create 目标，再 remove 原路径 |

空文件新增/删除保留 file mode，不能折叠成无变化。纯 rename 用扩展 rename headers；有字节变化时生成 whole-file hunk，保留末尾换行状态及 CRLF。Git 的合成仓库 apply/check 只验证补丁可导出，不是产品写回实现。

## 冲突与显式恢复

`planPatchApplication(scope, candidate, observations)` 要求全部 scope 路径的当前状态精确匹配固定 before，返回串行 steps 及初始 journal，不进行 I/O。observations 必须完整、唯一、无额外路径；unknown/不安全状态拒绝，不把无法读取当作 absent。readonly 文件也核对。

journal 固定 `{version:2,taskId,snapshotId,artifactId,direction,forwardSteps,completedSteps,inFlightStep}`。artifactId 是规范化候选 JSON 的 SHA-256；direction 为 forward/rollback，completedSteps 表示已持久完成的串行前缀，inFlightStep 只能是下一个索引或 null。journal 必须来自可信任务 Store；形状/Hash 校验不提供真实性或写权限。

`planPatchRecovery(scope, candidate, observations, journal, mode)` 接受 finish/rollback。先按完整日志重建应有状态，只允许与完成前缀相同，或与唯一在途步骤完成后相同；后者只能在日志已声明该在途步骤时计入。文件碰巧与候选匹配但没有日志，不能认定由本任务写入。任何未知/外部变化停止，不自动重放。

finish 返回剩余正向步骤。rollback 从已确认的正向前缀逆序生成反向步骤并返回新的 rollback journal；部分 rename 会先恢复/保全旧侧，再移除已创建的目标。rollback 中断只能续 rollback，不允许临时改回 finish。每步执行前后均须将来实现的 Host 重核、日志持久化及资源收束；这次只验证计划，不承诺磁盘原子性或真实断电恢复。

## 接线与兼容门槛

v2 模块不被当前产品 API/协调器/沙箱工具调用，v1 继续读写原目录。当前 `saveManagedArtifact` 必须拒绝 v2，禁止自动降成 modified 或落到 v1 目录；旧程序不得尝试读取将来的 v2 目录。没有现有数据迁移或用户数据删除。

下一步先实现独立 `managed-snapshots-v2` 与 `managed-artifacts-v2`，捕获安全不存在状态、字节/权限并验证重入与停止；再增加用户显式操作范围及任务版本标记，将工具/导出/接受与 UI 按格式分派。新增写入要求独占创建（O_EXCL）、目录链核对；移除/替换重核身份及哈希。完整日志在副作用前持久化，未知后果保留待恢复。多文件/跨编辑器/多 Host 没有原子事务承诺，不能用本纯数据测试代替。

接入前停止服务并备份全部项目外数据；新目录单独校验，失败保留 v1 可读。回退时保留 v2 当前副本/导出及升级前备份，再切换旧版；恢复旧备份会丢失备份后记录，不能自动清空新历史。将来真实沙箱/模型验收按新的调用授权和合成传输范围执行。
