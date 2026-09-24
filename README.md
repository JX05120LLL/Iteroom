# Iteroom

**面向代码仓库、逐步学习的本地编程助手。**

Iteroom 计划以 DeepSeek Harness（DSH）为编程引擎，首版提供文字对话、代码理解、修改、验证与审阅。后续阶段加入实时语音协作、个人偏好、项目经验检索和经评测的策略改进。项目面向开源发布，采用本地 Web 页面与 npm 命令启动的产品形态。

> 当前状态：M0 阶段有一个基于 DSH Web Profile 的本地 UI 审核版。已选方案 C 作为视觉基线：整体白色背景、深绿色文字与控件、双拱门 Logo，以及独立的白底通话页；文字会话仍使用 DSH 的页面框架。真实语音、Iteroom 的完整文字任务闭环、发行包及干净环境验收均未完成。下方 `npx` 命令仍是发行目标，当前不可运行；npm 包尚未发布。

计划中的终端用户体验：

~~~sh
cd your-project
npx iteroom .
~~~

命令启动本机服务，打开浏览器，并将当前目录作为项目工作区。实际支持的 Node 版本、平台和首次配置步骤会在 M0 技术验证后确定。

## 本地审核 UI

在本仓库执行以下命令，启动源码内的 UI 审核版，默认以 Iteroom 仓库作为 Host 工作目录；要开始 DSH 文字会话，仍需在界面中选择工作区：

~~~powershell
npm install --registry=https://registry.npmjs.org
npm run build
npm run review
~~~

如需查看另一个本地项目，运行 `npm run review -- D:\code\your-project`，并换成真实存在的目录。启动后打开终端打印的本机页面地址。在侧栏选择“语音空间”，或进入文字会话后点击输入区的“语音讨论”按钮，可查看通话页面；点击“返回文字工作台”回到原会话。通话页明确显示“尚未连接”，麦克风、字幕和结束通话控件只是禁用的界面占位，不会请求麦克风权限或建立通话。页面预览无需填写真实模型凭证。若自行配置模型并发起代码任务，DSH Host 将按其配置访问所选项目；Iteroom 对权限、数据流和任务结果的端到端验收尚未完成。制作公开审核截图时请指定全新的 `ITEROOM_DSH_HOME`，避免带入本机已有的 DSH 会话。

当前 `npm run review` 由本地源码启动固定版本的 DSH（`@deepseek-ai/dsh@0.1.5-rc.3`），不是已经发布的 `iteroom` 命令。UI 通过 `iteroom.patch.yml` 装载本仓库的浏览器插件；没有复制 DSH Agent Loop 或前端整套源码。开发检查可运行 `npm run check`。本机已在 Windows、Node.js 24.14.0 和 Chromium 中验证品牌显示、语音入口、通话页返回、桌面与 390×844 手机布局，以及浅色/深色偏好下的白底效果；手机通话页没有横向溢出。方案 C 固定为白色品牌皮肤，即使 DSH 外观设为深色也会保持白底。尚未验证真实模型任务、音频链路和跨平台启动。DSH 原有的内测声明、模型配置提示与部分首页文案暂时保留。

审核截图：[空会话首页](docs/screenshots/iteroom-home-desktop.png) · [输入区语音按钮](docs/screenshots/iteroom-composer-voice.png) · [桌面通话页](docs/screenshots/iteroom-call-desktop.png) · [手机宽度通话页](docs/screenshots/iteroom-call-mobile.png)。

## 文档入口

- [产品需求与阶段路线](docs/PRD.md)：定位、首版验收、复用边界、未来语音与记忆能力。
- [已选方案 C 设计稿](docs/design-options/README.md)：白色主题、双拱门 Logo、独立通话页的可编辑源文件与预览图。
- [Codex 项目约定](AGENTS.md)：后续协作时需要保持的实现与验收边界。

## 最近的工作

1. 补齐 DSH Web 接入的提交、事件、停止、恢复和 Diff 验证。
2. 验证 npm 打包后在干净环境启动，明确原生依赖和本机数据目录。
3. 按 PRD 完成 M1 文字闭环与实际验收。

可公开使用的 npm 包与对外发布均尚未完成。项目名称与包名在正式发布前会再次核对。
