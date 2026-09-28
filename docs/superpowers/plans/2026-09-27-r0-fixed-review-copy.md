# R0 Gate B 固定副本实施计划

本轮继续既定 R0 方案，不迁移产品入口，不提交/推送。真实模型和沙箱部署仍须明确授权。

接口：`createFixedReviewCopy(fixture, input)` 返回独立受管 fixture、固定 record 和 `dispose()`。仅一次性合成仓库；不提供用户项目快照 API。原输入 SHA、旧/新内容、diff、索引模式在副本复验一致。复制对象按内容验证，禁止 checkout/过滤器/共享 objects/外部 Git 配置。

- [x] 先补测试：源修改及删除后副本稳定；三种输入、BOM/CRLF/binary/mode；副本变更拒绝；attributes/filter/外部 object store 在执行前拒绝。
- [x] 无 HEAD 实测后采用 staged 与工作树一致的新增加 untracked；未暂存分歧拒绝。无需伪造提交。
- [x] 实现 Git 前置限制、独立对象/索引/字节重建和前后校验；构造失败清理自有资源。
- [x] 用校验过的 OCR v1.12.9 真 CLI 在副本上运行 preview/rule；源在构造后修改；匿名证据记录固定输入、实际错误与覆盖。
- [x] 固定副本与既有 R0 合计 66/66；原有测试、类型/构建通过。Gate B 在限定平台与输入边界内通过，见 FIXED-REVIEW-COPY。

后续用户明确授权无模型 Docker/OpenSandbox 验证，执行范围扩展见 OPENSANDBOX-PLAN；不是依据本计划自动部署。最终文档/差异核对记录在 STATUS。

重点 review：清理作用域；源索引/HEAD 变化；配置/attributes 在 diff 前拒绝；完整对象复制限额；不能把固定副本解释成恶意仓库原子快照或操作系统只读保护。
