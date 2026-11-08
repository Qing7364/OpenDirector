# Issue #87 Windows 端执行指令

[English](issue-87-windows-handoff.md)

在 Windows 项目的 Codex 中执行以下任务。继续使用 Draft
[PR #193](https://github.com/ThinkFlowLab/OpenDirector/pull/193) 的分支
`Qing7364/OpenDirector:codex/issue-87-timeline-text`。先拉取 PR 描述中标明的
共享修复检查点并记录完整 SHA，保留本机已有工作；使用 fast-forward，禁止强推或合并
PR。[验收记录](issue-87-validation.md) 中较早的 Windows 结果不能证明新检查点通过。

## 执行任务

1. 阅读 `AGENTS.md`、复审修复计划及适用安全规则。核对 Windows、CPU、Python、Node
   的实际架构，仅安装缺失的依赖：Python 3.11+、Node >=24.22.1、FFmpeg/ffprobe、
   Playwright 和兼容 Chromium。在本机构建 Windows wheel，装入独立全新环境。
2. 修复 `agent/owner_rights.py` 的 ACL 回滚记账：`prepare()` 在 `unchanged()` 和
   `set_acl()` 之前就把 additions 加进 `self.changes`。未真正写入的尝试会错误认领
   外部写入者后来增加的同字节 owner deny，关闭租约时可能将其删除。区分计划写入与
   实际安装的条目，并处理“setter 已成功、后置检查却发生冲突”的情况，不能只把
   append 移到最后一次检查之后。保留其他 ACE、owner、保护标记、只读约束及拒绝回退。
3. 先补失败回归：第一次尝试未写入；外部写入者给非可写祖先增加同字节 deny；重试；
   正常关闭租约；最终外部 deny 必须仍在。另覆盖 setter 成功后的冲突、初始化失败、
   取消及清理。既做确定性的控制流检查，也使用真实 WinAPI 描述符与并发 writer。
   Mac 发现属于控制流复现，不将它表述为已经证明原生沙箱逃逸。
4. 将浏览器测试的 Windows host adapter 正式提交。不能只保留本机 ignored 副本。
   处理进程退出、源码 `PYTHONPATH` 分隔符（`path.delimiter`）、wheel 服务的独立
   `PATH`、可执行文件查找与内存采样。只清理本测试创建的进程；没有实际采样能力时
   明确写出限制，不伪造性能数字。
5. 对最终代码运行完整 Python/Node 测试、build、contracts `--check`、i18n、浏览器
   locale/manifest 检查及四项 import 边界检查；在无源码导入的独立环境验收 wheel。
   不删测试、不放宽断言、不扩大 skip/xfail 门禁。
6. 执行七组浏览器检查：`timeline_text_editing.mjs`、`timeline_text_render.mjs`、
   `timeline_text_coverage.mjs`、`timeline_text_archive.mjs`、
   `timeline_text_desktop.mjs`、`timeline_text_installed.mjs`、`timeline_workflow.mjs`。
   desktop 与 installed 注册在 manual lane，需要真实桌面或新 wheel 环境。验收中文、
   帧边界、层次/位置、真实混音、横竖 1080p MP4、UI/Agent 接续、保存重开/撤销/锁定、
   字体与正文依赖、可编辑包跨工程、两份不可变成片、双语导出提示及无文字回归。
7. 在验收记录追加输入 SHA/文件哈希、系统/架构、版本、完整命令、退出码、通过/失败/
   跳过数量、wheel 哈希、真实帧和截图及限制。保留历史记录。提交 ACL 修复、可移植
   helper、回归及对应证据；同步既有 upstream 后正常推送到同一 PR 分支。最终原生
   验收和剩余 review 未完成前保持 Draft。

使用隔离生成的工程和浏览器 profile。本任务不需要用户工程、付费模型、SSH/远控配置
或修改系统安全策略。
