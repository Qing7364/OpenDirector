# Issue #87 Windows 收尾执行指令

**当前交接已执行完成（2026-11-08）。** 最终源码冻结 `97edaf4e`（main `c54d78eb`），
原生窗口、main 整合、独立复审、Windows scoped checks、新 wheel 和 Linux 门禁已完成。
本文件下方启动指令保留作历史复核，不是新的重复验收待办；原版本结果不改标。
完整结果、最终交付回执和限制见[验收记录](issue-87-validation.md)及 PR 描述。保持 Draft，等待维护者复审。
English: this handoff is executed; retain its original instructions and revision boundaries for audit.

[English](issue-87-windows-handoff.md) · [完整分工与验收计划](issue-87-post-windows-plan.md)

**原交接时的背景：** `1799464f` 已完成上一轮约定的 Windows 补验，结果继续有效。本次剩余的是 ACL 最终检查/写入窗口、最新 main 整合和最终交付。发布本计划只改变文档，不改变该版本的产品代码，不触发重复功能验收。

Windows Codex 是剩余产品代码的唯一写入方，连续负责整合、原生验证/必要修复、冻结前独立复审、最终验收、证据、正常推送及 CI 问题处理。当前 Mac 会话负责任务准备与交付后的只读核对；Linux GitHub Actions 负责当前提交的跨平台门禁。

将下面内容发送到 Windows 原来的 Codex 对话：

```text
继续完成 OpenDirector Draft PR #193 的全部剩余工作。
项目：C:\Users\Qing Peng\OpenDirector
仓库/分支：Qing7364/OpenDirector，codex/issue-87-timeline-text

你是本批次唯一的产品代码写入方。复用现有环境，保留本机工作，安全同步远端；
阅读 AGENTS.md、适用安全规则、docs/development/issue-87-post-windows-plan.md
和 issue-87-validation.md 最新 Windows 记录。责任表、冻结规则和门槛是本次执行依据。

按 Task 2 → Task 1 → 源码冻结 → Task 3 → Task 4 连续执行：

1. 记录 PR/main 完整 SHA，将本次 main 合入现有 PR 分支，保留历史。
   按计划解决冲突，保留音色库与字幕两侧能力，重新生成依赖锁和契约，核对自动合并区域。
   将现有项目环境同步到合并后的 Python/npm 锁定依赖，记录实际版本，无需重装运行时。

2. 用真实 WinAPI writer 验证最后一次 before_write 返回后、原始 NtSetSecurityObject
   调用前的窗口。一次核对完整权限生命周期/并发矩阵及外部同字节 deny。
   原生复现则修复并证明有效；若内核不允许该时序，提供证据说明模拟假设为何不成立。
   Mac 反例只证明控制流；不得只增加检查次数、删除断言、扩大 skip 或放宽权限。

3. 完整验收前安排独立只读复审，集中处理确认的范围内缺陷；新假设先定点复现。
   之后提交源码冻结点，记录生产代码、测试、构建/CI 配置、依赖锁和打包资源哈希。
   正常推送冻结版本，让 Linux CI 与 Windows 最终检查并行。

4. 在稳定源码上集中完成完整 Python/Node、build、contracts、i18n、browser locale/manifest、
   四项 import 边界；保留已有真实 CLI 门禁并核对 skip。Windows 跑 timeline
   editing/render/archive 和独立 voice fixture。重建 Windows wheel，装进全新 venv，
   运行 pip check、verify_install.py --python <wheel-python>、受影响原生模块和
   timeline_text_installed.mjs，核对实际文件/帧、无源码导入和后台 PATH 无 Node。
   Linux CI 覆盖标准浏览器工作流/助手面板及完整门禁，由你跟踪到最终结论。

5. 确认失败在本批次内定位、修复，按影响范围复验；共享基础或依赖改变才扩大范围。
   代码变动记录新冻结点；纯状态/验收文档变化不重跑 Windows 功能测试。
   保留历史 1080p/2000 cue 证据，除非实际相关改动要求更新。

6. 更新验收记录、旧计划/handoff 状态和 PR 描述；区分源码冻结 SHA 与最终证据提交 SHA，
   证明相关运行输入未变。推送前同步 configured upstream 并保留 merge 历史，正常推送
   同一分支。保持 Draft，不强推、不合并 PR、不自行发送 reviewer/外部聊天消息。

正常步骤之间不需要再让我逐项确认。真实凭证/权限缺失、超出范围的产品取舍或原生证据
仍无法判定时，明确报告阻塞和所缺条件；不要通过反复全量测试掩盖不确定性。

最后统一返回：main 基线、源码冻结 SHA、最终 SHA/输入一致性、ACL 结论与原生证据、
逐项检查/失败/skip、wheel 哈希、CI 链接和结论、PR 状态及剩余阻塞。
```

安装验证的 `--python` 参数不能省略。将 `OPENDIRECTOR_INSTALLED_PYTHON` 设置为新 wheel venv 的 Python 绝对路径，沿用已有 Playwright/Chrome 配置：

```powershell
& $env:PYTHON scripts/verify_install.py --python $env:OPENDIRECTOR_INSTALLED_PYTHON
node tests/browser/timeline_text_installed.mjs
```

本批次不需要 SSH/远控配置、付费模型或系统安全策略修改。
