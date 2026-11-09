# Issue #87 Windows 端补验指令

[English](issue-87-windows-handoff.md)

继续在 `Qing7364/OpenDirector:codex/issue-87-timeline-text`、Draft
[PR #193](https://github.com/ThinkFlowLab/OpenDirector/pull/193) 上工作。`733001a2`
已交付完整 Windows 验收；不要重复安装环境或重新实现其 ACL/host adapter。
本次只需验证[完整复审修复](issue-87-final-review-plan.md)后的最新提交。

1. 保留本机改动，以 fast-forward 同步 PR 分支，记录完整输入 SHA 和实际 Windows/CPU/Python/Node 版本。阅读 `AGENTS.md`、修复计划和适用安全规则。
2. 使用已有未打包的 Python.org 环境，设置 `PYTHON`。先运行以下相关测试，不放宽断言或扩大 skip/xfail：

   ```powershell
   & $env:PYTHON -m pytest tests/test_owner_rights.py tests/test_owner_rights_journal.py tests/test_owner_rights_lifecycle.py tests/test_owner_rights_resume.py tests/test_native_runtime.py tests/test_native_sessions.py tests/test_directory_links.py tests/test_skill_snapshot.py tests/test_execution_files.py tests/test_posix_execution_files.py tests/test_timeline_packages.py -q -ra
   node --test tests/browserHost.test.ts
   ```

   核心检查：清理阶段写入成功后发生真实 oplock 冲突，外部同字节 deny 仍保留；Claude 两轮经过真实命令构建，第二轮技能更新且保留同一会话/目录；目录链接修复不删除普通目录。POSIX rename 用例在 Windows 明确跳过，不冒充原生 POSIX 验证。
3. 运行完整 Python/Node、contracts `--check`、i18n、browser locale/manifest、四项 import 边界及 build。记录所有失败与 skip 原因。新增 host 发现用例会在独立目录验证无 `.venv`、PATH Python、显式覆盖及 venv 优先级。
4. 运行 `timeline_text_editing.mjs` 和 `timeline_text_render.mjs`：文字条移动、左右裁剪应在按住鼠标期间更新，Escape 取消、单次撤销、UI/Agent 保存重开、中英文和真实 MP4 不回退。使用已有 `PLAYWRIGHT_MODULE` / `CHROMIUM_PATH`，测试自建隔离工程和服务。
5. 从该最终源码重建 Windows wheel，安装进全新 venv，将 `OPENDIRECTOR_INSTALLED_PYTHON` 设置为该新 venv 的 Python 可执行文件绝对路径，再执行：

   ```powershell
   & $env:PYTHON scripts/verify_install.py --python $env:OPENDIRECTOR_INSTALLED_PYTHON
   node tests/browser/timeline_text_installed.mjs
   ```

   确认无源码导入、后台 PATH 无 Node。历史 wheel 哈希不能代表新源码。
6. 仅在当前改动或失败需要时扩大浏览器/原生引擎验证。原 `733001a2` 七组、1080p 和性能证据保留原版本边界，不伪称新提交已重新测量。
7. 将完整 SHA、命令/退出码、通过/失败/跳过数量、wheel 哈希、实际浏览器结果及限制追加到[验收记录](issue-87-validation.md)。发现问题先复现并修复，再重跑相关及完整检查；提交证据/必要修复，按 upstream 同步后正常推送同一分支。保持 Draft，不强推或合并。

不需要 SSH、远控配置、付费模型或修改系统安全策略。macOS 的确定性 ACL 测试不替代本机 WinAPI；此前真实 Windows 验收也不替代本次新增清理用例。
