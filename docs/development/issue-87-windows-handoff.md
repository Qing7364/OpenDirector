# Issue #87 Windows follow-up validation

[中文](issue-87-windows-handoff.zh-CN.md)

Continue on `Qing7364/OpenDirector:codex/issue-87-timeline-text`, Draft
[PR #193](https://github.com/ThinkFlowLab/OpenDirector/pull/193). Commit `733001a2`
already delivered the complete Windows acceptance. Reuse its environment and
tracked ACL/host adapters. Validate the latest [complete-review repairs](issue-87-final-review-plan.md).

1. Preserve local work, fast-forward to the current PR head, and record its full SHA and actual OS/CPU/Python/Node versions. Read repository guidance, the repair plan and applicable security rules.
2. Set `PYTHON` to the existing unpackaged Python.org environment. Run the targeted checks below without weakening assertions or expanding skips/xfails:

   ```powershell
   & $env:PYTHON -m pytest tests/test_owner_rights.py tests/test_owner_rights_journal.py tests/test_owner_rights_lifecycle.py tests/test_owner_rights_resume.py tests/test_native_runtime.py tests/test_native_sessions.py tests/test_directory_links.py tests/test_skill_snapshot.py tests/test_execution_files.py tests/test_posix_execution_files.py tests/test_timeline_packages.py -q -ra
   node --test tests/browserHost.test.ts
   ```

   Confirm that a successful cleanup write followed by a real oplock conflict preserves an external identical deny. Confirm real command preparation on two Claude fixture turns, refreshed skills, stable session/workspace and refusal to remove ordinary directories. POSIX open-file rename cases are explicitly skipped on Windows; adapter tests do not certify native POSIX behavior.
3. Run complete Python/Node suites, generated contracts, i18n, browser locale/manifest, four import-boundary contracts and build. Record every failure and skip reason. The new host regression independently covers PATH-only Python, explicit overrides and project venv preference.
4. Run `timeline_text_editing.mjs` and `timeline_text_render.mjs` with the existing Playwright/Chrome settings. Verify live move/start-trim/end-trim previews before pointer release, Escape cancellation, single undo, bilingual UI/Agent persistence and real MP4 output. These scripts create isolated projects and services.
5. Build a fresh Windows wheel from this final source and install it into a new venv. Set `OPENDIRECTOR_INSTALLED_PYTHON` to the absolute Python executable path in that new venv, then run:

   ```powershell
   & $env:PYTHON scripts/verify_install.py --python $env:OPENDIRECTOR_INSTALLED_PYTHON
   node tests/browser/timeline_text_installed.mjs
   ```

   Verify no source imports and no Node on the backend PATH; an old wheel hash does not identify this source.
6. Broaden browser/native-engine checks only when the changes or an observed failure justify them. Retain `733001a2`'s seven-suite, 1080p and performance evidence under its original revision; do not claim those measurements were repeated.
7. Append the exact SHA, commands/exit codes, pass/fail/skip counts, wheel hash, observed browser results and limitations to the [validation record](issue-87-validation.md). Reproduce and fix any failures before rerunning affected and complete checks. Commit evidence/necessary repairs, synchronize the configured upstream and push normally to the same branch. Keep Draft; do not force push or merge.

No SSH/remote-control setup, paid models or machine security-policy changes are needed. Deterministic macOS ACL tests do not replace WinAPI; previous Windows acceptance does not certify the new cleanup cases.
