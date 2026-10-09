# 下一轮接续提示

请继续开发 `D:\code\Iteroom`。先只读核对 Git 工作区、HEAD/远程与所属服务，保留已有改动。2026-10-09 R5-3 提交复验父基线为 `main / 5e904d9b7a4c62ee4b1a5bded0baab42a621b1cd`；用户已授权本次提交到 `origin/main`，实际交付 Hash/工作区以实时 Git 为准。复验见 [提交报告](r5/patch-contract-push-2026-10-09-report.json)，原 JSON 未提交字段保留生成时事实；下一轮不继承本次 commit/push 或真实模型额度。

阅读 AGENTS.md、README.md、CONTEXT.md、PRD、ARCHITECTURE、ROADMAP、STATUS、ACCEPTANCE；以及 docs/r5/PATCH-CONTRACT.md、PATCH-PLAN.md、PATCH-EVIDENCE.md、patch-contract-delivery-2026-10-09-report.json、最终成功/故障报告和相关源码测试。R5-1/R5-2 的配置、安装、取消等待和历史串行保护保留，证据见 EVIDENCE.md、INSTALLATION-EVIDENCE.md 与 SUPPORT-MATRIX.md。

## 当前事实

- R0–R4 最小退出只在固定 Windows/版本/合成选定现有文本范围通过，完整 P0/A01–A21/R5/v1 未完成。
- R5-3 新增内部纯 `managed-patch-contract.js`，实现固定 scope、四种文本候选的严格重建/导出、冲突与 finish/rollback 计划。相关 29/29；全量 158 项中 157 通过、1 Windows 条件跳过；check/build/test:web 和 45 项包 dry-run 通过。
- 实际一次性 Git 验证每类型两个操作、补丁应用与反向恢复、原文件/HEAD/index/status；11 个恢复前缀为纯状态计划。故障 probe 确认初始化失败也清理本次临时目录。最终报告 Hash 与当前模块/脚本一致；早期报告不替代最终证据。
- v2 尚未接 API/Store/沙箱/UI。当前修改仍限选定现有文本；v1 Store 拒绝 v2/伪装 v1 的 v2，旧产物冷读通过。没有用户数据迁移或真实 v2 文件恢复。
- 模型请求、实际沙箱分配和用户源码外传均 0。本轮 Web smoke 不等于浏览器验收，新 45 文件包尚未重新独立安装。构建 bundle Hash 单独记录，不据历史 Hash 冒充当前验证。

## 下一可验证切片

先补独立 v2 安全快照与产物持久化，不直接扩大现有沙箱工具或宿主写入权限。按 PATCH-PLAN 的第一项推进：

1. 先固定 v2 Store 输入/目录/备份与冷读契约。将 taskId、显式写入 scope、absent 与实际文件 Hash/字节绑定；不存在目标必须是已存在安全父目录下的明确获准路径。
2. 从现有受限读取/快照代码复用路径、真实文件身份、symlink/junction/硬链接拒绝与 UTF-8/体积检查；absent 不能由任意读取错误伪造，父目录或条目变化拒绝。不要把纯元数据校验当作真实路径证明。
3. 使用独立 `managed-snapshots-v2` / `managed-artifacts-v2`，严格冷读及任务/scope/candidate Hash 关联；v1 目录保持原读写行为、不混写、不自动迁移。增加损坏、越界、重复/并发捕获、取消/停止等待、权限清单篡改和失败清理测试。
4. 先纯函数/临时文件及合成 Git 检查，无模型、无沙箱。只有可信 Host 已捕获并批准的 scope 才能用于后续工具；产品 task 标记/API/UI 接线另做切片，不把“模块可用”写成产品已支持新增/删除/重命名。
5. 保存匿名证据并同步核心文档。下一阶段再接显式操作批准、沙箱工具/库存/导出及 UI，最后实现副作用前持久 journal、独占创建、移除/替换身份重核和实际中断恢复。未知后果不自动重放，恢复前确认活动写入者已停止。

## 验证与约束

复验命令见 PATCH-EVIDENCE.md，新增探针用新名称，保留最终旧报告。Git 合成测试采用独立配置/hooks、`GIT_OPTIONAL_LOCKS=0`，防止 status 的 stat cache 刷新污染 raw index 检查；不改用户 Git 配置。固定 OCR 位于项目外 `%LOCALAPPDATA%\Iteroom\tools\ocr\v1.12.9\opencodereview-windows-amd64.exe`，ITEROOM_OCR_BIN 使用该路径；SHA256 为 `ae6f4785fea34a5cfef93ad22d8e7fb8032bbd12c45f2cbcc98cbe1b38cceff1`。

保留方案 C 白色 UI、双拱门 Logo、独立禁用通话预览和旧完整 DSH Web 开发入口；旧入口仍有宿主工具，不外推受管隔离保证。不复制第二套 Loop，不提前接语音/RAG/记忆/分布式调度，不修改 RepoPilot。不要输出或复制私有凭证。真实模型需新的次数/tokens/费用与仅合成传输授权；此次切片无需启动 Docker 或模型。

将来真实格式接线前须停止服务并备份全部项目外数据，验证旧副本可读；回退保留 v2 副本/导出及升级前备份，恢复旧备份会丢失其后记录，不自动清空新历史。不要自动提交/推送、发布或清理用户数据。最终分别报告离线、实际 Git/CLI、mock、真实模型、实际沙箱、浏览器与发行结果，不将局部绿色称为 R5/v1 完成。
