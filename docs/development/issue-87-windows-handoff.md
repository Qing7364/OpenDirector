# Issue #87 Windows handoff

[中文指令](issue-87-windows-handoff.zh-CN.md)

Continue Draft [PR #193](https://github.com/ThinkFlowLab/OpenDirector/pull/193)
on `Qing7364/OpenDirector:codex/issue-87-timeline-text`. Fetch the published
shared-fixes checkpoint and record the full SHA before changing code. Preserve
existing work, use fast-forward updates, and do not force-push or merge the PR.
The PR body identifies the checkpoint; older Windows evidence in
[the validation record](issue-87-validation.md) does not validate this revision.

## Work to complete on Windows

1. Read `AGENTS.md`, the review-fixes plan, and applicable security rules.
   Verify native OS, CPU architecture, Python and Node architecture. Install
   only missing prerequisites: Python 3.11+, Node >=24.22.1, FFmpeg/ffprobe,
   and a compatible Chromium with Playwright. Build a Windows wheel locally
   and install it into a separate fresh environment.
2. Fix ACL rollback journaling in `agent/owner_rights.py`. `prepare()` currently
   appends additions to `self.changes` before `unchanged()` and `set_acl()`.
   An attempt that never wrote can therefore claim a later external writer's
   identical owner deny and remove it during close. Distinguish proposed changes
   from actually installed entries. Also account for a successful setter followed
   by a post-write conflict: moving the append after the final check alone can
   lose changes that need cleanup. Preserve unrelated ACEs, ownership, protection
   flags, existing read-only restrictions, and fail-closed behavior.
3. Add failing regressions first. Cover an abandoned first attempt, an external
   identical deny on a non-writable ancestor, retry, and real lease close. The
   external deny must survive. Also cover setter success followed by a conflict,
   initialization failure, cancellation and cleanup. Use real native descriptors
   and concurrent writers as well as deterministic control-flow tests. The Mac
   finding is a control-flow reproduction, not proof of a native sandbox escape.
4. Commit portable browser host adapters. Local ignored script copies are not
   deliverables. Adapt process cleanup, source `PYTHONPATH` (`path.delimiter`),
   installed-server `PATH` isolation, executable discovery and memory sampling
   for Windows. Terminate only processes owned by the test. Unsupported memory
   measurements must be reported honestly, never replaced by fabricated values.
5. Run full Python and Node tests, build, contract generation check, i18n,
   browser locale/manifest checks, and all four import-boundary contracts.
   Revalidate the installed wheel with source imports disabled. Do not remove
   tests, weaken assertions, or broaden skip/xfail conditions to obtain a pass.
6. Run all seven suites on the final source/wheel revision:
   `timeline_text_editing.mjs`, `timeline_text_render.mjs`,
   `timeline_text_coverage.mjs`, `timeline_text_archive.mjs`,
   `timeline_text_desktop.mjs`, `timeline_text_installed.mjs`, and
   `timeline_workflow.mjs`. The desktop and installed suites have explicit native
   prerequisites and are registered in the manual lane. Verify Chinese text,
   frame boundaries, layering/position, actual mixed audio, 1080p landscape and
   portrait MP4, UI/Agent continuation, persistence/reopen/undo/locks, retained
   fonts/source assets, editable package round trips, two immutable publications,
   bilingual export diagnostics and the no-text regression.
7. Append reproducible results to the validation record: input SHA and file
   hashes, OS/architecture, versions, exact commands, exit codes, pass/fail/skip
   counts, wheel hash, actual frames/screenshots and limitations. Preserve older
   evidence as historical results. Commit the ACL fix, portable helpers, tests and
   evidence together as appropriate; synchronize with the existing upstream and
   push normally to the same PR branch. Keep the PR Draft until the final native
   acceptance and outstanding review items are resolved.

Use isolated generated projects and browser profiles. No user content, paid
models, SSH/remote-control configuration or machine security-policy changes are
needed for this task.
