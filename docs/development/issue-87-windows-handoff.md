# Issue #87 Windows completion handoff

**Executed on Windows, 2026-11-08.** Final source freeze is `97edaf4e` (main `c54d78eb`).
Native windows, main integration, independent review, scoped Windows checks, a fresh wheel and Linux gates
are complete. The startup instructions below are historical reproduction guidance, not new pending work.
See the [validation record](issue-87-validation.md) and PR delivery receipt for exact revisions and limits.
Keep Draft; maintainer review is still required. 中文：本交接已执行，保留历史版本边界，不重复改标旧验收。

[中文](issue-87-windows-handoff.zh-CN.md) · [Complete allocation and acceptance plan](issue-87-post-windows-plan.md)

**Original handoff context:** `1799464f` completed the previous agreed Windows follow-up; retain that evidence. Remaining work is the final ACL check/write window, current main integration and final delivery. Publishing this plan changes documentation only and does not require repeated functional acceptance of unchanged product code.

Windows Codex is the sole remaining product-code writer. It owns integration, native diagnosis/repair, independent pre-freeze review, final acceptance, evidence, normal pushes and CI corrections. The current Mac chat prepares this handoff and audits delivery read-only; Linux GitHub Actions covers the current revision's cross-platform gates.

Send the following to the existing Windows Codex chat:

```text
Complete all remaining work for OpenDirector Draft PR #193.
Project: C:\Users\Qing Peng\OpenDirector
Repository/branch: Qing7364/OpenDirector, codex/issue-87-timeline-text

You are the sole product-code writer for this batch. Reuse the installed environment, preserve local
work and safely synchronize the remote branch. Read AGENTS.md, applicable security rules,
docs/development/issue-87-post-windows-plan.md and the latest Windows validation record.
The ownership table, freeze rules and gates in the plan govern this execution.

Execute Task 2 -> Task 1 -> source freeze -> Task 3 -> Task 4 continuously:

1. Record exact PR/main SHAs and integrate that main revision into the existing PR branch without
   rewriting published history. Follow the conflict plan, preserve voice-library and timeline-text
   behavior, regenerate locks/contracts and inspect automatic merges.
   Synchronize the existing project environments with the merged Python/npm dependency locks and
   record resolved versions; do not reinstall the runtimes.

2. Use a real WinAPI writer after the final before_write check returns and before the original
   NtSetSecurityObject call. Review the complete permission lifecycle/concurrency matrix and identical
   external denies together. Fix a natively reproduced issue and prove the correction; if Windows
   disallows the ordering, show evidence identifying the invalid simulation assumption.
   The Mac probe establishes control flow only. Another pre-check alone does not establish atomicity.
   Do not remove assertions, broaden skips or weaken permissions.

3. Obtain an independent read-only review before broad acceptance. Resolve confirmed in-scope defects;
   investigate new hypotheses with focused probes. Commit a source freeze and record hashes for
   runtime code, tests, build/CI configuration, dependency locks and packaged resources.
   Push normally so Linux CI and final Windows checks can run concurrently.

4. On stable source, consolidate full Python/Node, build, contracts, i18n, browser locale/manifest
   and four import boundaries, with existing real-CLI gates and explicit skip reasons. Windows runs
   timeline editing/render/archive and the separate voice fixture. Rebuild the Windows wheel, install
   into a fresh venv and run pip check, verify_install.py --python <wheel-python>, affected native
   modules and timeline_text_installed.mjs. Check actual media/files, no source imports and no Node
   on the backend PATH. Track Linux CI's complete gates, standard browsers and assistant panels.

5. Diagnose and fix confirmed failures within this batch; rerun affected checks, broadening only
   when shared foundations or dependencies change. Record a new freeze when code changes.
   Pure status/evidence documents do not require repeating Windows functional checks.
   Retain historical 1080p/2000-cue evidence unless relevant changes warrant updated measurements.

6. Update validation evidence, superseded plan/handoff status and PR metadata. Distinguish the source
   freeze SHA from the final evidence commit and prove relevant runtime inputs are unchanged.
   Before pushing, synchronize the configured upstream while preserving merge history, then push
   normally to the same branch. Keep Draft. Do not force push, merge the PR or send reviewer/chat messages.

Continue routine steps without repeated confirmation. Actual missing credentials/permissions,
out-of-scope product decisions or unresolved native evidence must be reported with the exact blocker.
Repeated full suites cannot settle an unresolved native hypothesis.

Return one complete delivery: main baseline, source freeze SHA, final SHA/input equivalence, native
ACL conclusion/evidence, check/failure/skip results, wheel hash, CI links/conclusion, PR state and blockers.
```

The install verifier requires `--python`. Set `OPENDIRECTOR_INSTALLED_PYTHON` to the new wheel venv's absolute Python path and reuse existing Playwright/Chrome settings:

```powershell
& $env:PYTHON scripts/verify_install.py --python $env:OPENDIRECTOR_INSTALLED_PYTHON
node tests/browser/timeline_text_installed.mjs
```

No SSH/remote-control setup, paid models or machine security-policy changes are needed.
