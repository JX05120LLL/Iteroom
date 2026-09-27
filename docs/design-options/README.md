# Iteroom UI 设计基线 · 方案 C

方案 C 是已确定的视觉基线：整体白色背景、深绿色文字与控件、双拱门 Logo；通话页是独立的白底简洁布局。仓库交付只保留这一套可编辑资产。废弃 A/B 目录为本地忽略文件，删除操作被自动策略阻止，尚未物理删除，不再作为设计入口。

- [总览图](workshop/overview.png) · [文字工作台](workshop/workspace.png) · [独立通话页](workshop/call.png)。
- [手机工作台](workshop/workspace-mobile.png) · [手机通话页](workshop/call-mobile.png) · [通话页参考尺寸](workshop/call-reference-size.png)。
- [总览 HTML](workshop/overview.html) · [工作台 HTML](workshop/workspace.html) · [通话页 HTML](workshop/call.html) · [Logo SVG](workshop/logo.svg)。

设计稿里的 SampleRAG、文件、会话和字幕是示例，不代表真实任务或未来 RAG 范围。语音服务尚未接入，通话控制不可用，不请求麦克风。

新文字版沿用视觉，不沿用设计稿的功能完成暗示。按 [PRD](../PRD.md) 增加项目/模型/沙箱配置、任务进展、审查发现、覆盖清单、权限等待、Diff、验证及接受/放弃操作。已有稿件尚未呈现这些完整流程，后续对应开发阶段补齐；只读模式和服务不可用时禁用执行按钮。

设计图、浏览器截图与真实执行验收分别记录。现有截图见 [README](../../README.md)，实现事实见 [STATUS](../STATUS.md)。

2026-09-27 确认暂定 UI：以 DSH 的侧栏、会话列表、消息区与输入框为主体，只增加任务/审阅入口及必要状态；Ant Design 局部补充权限、列表、配置、日志和决策控件。十页独立原型覆盖项目、任务、Diff、验证、历史与禁用通话，使用合成数据；该原型重现 DSH 布局，未接入真实 DSH 会话运行时，也未替换仓库产品界面。方案 C 白色与双拱门品牌资产继续保留。
