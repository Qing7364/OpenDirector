# Issue #87 PR #193 review fixes implementation plan

> **For agentic workers:** Use superpowers:executing-plans task by task. The user authorized implementation, integration and a final Windows handoff.

**Goal:** Resolve the shared Mac-verifiable review findings, integrate current main without rewriting published history, and publish a fixed checkpoint for Windows ACL work and final validation.

**Architecture:** Keep business references independent of canvas visibility; project their visible edges separately. Reuse main's rule-facts generator and error-code translation boundaries. Merge main into the published feature history, preserving both the timed-text feature and Windows changes.

**Tech Stack:** Python 3.11+, Pydantic >=2.12,<3, TypeScript/React, generated contracts, pytest, Node tests and real browser tests.

**Spec:** Issue #87 and `issue-87-editable-timeline-text-plan.md`; PR review 5818207086; user-authorized findings from the November 8 review.

## Global constraints

- Preserve existing user work and published commits; no force push or wholesale conflict-side selection.
- Preserve UI/Agent shared commands, locks, versions, references, history and reversible editing.
- Keep font limits at 16 resources / 32 MiB each / 64 MiB aggregate, text at 2,000 overlays / 4,096 code points each / 200,000 total code points.
- User-visible changes provide zh-CN and en-US strings; business identities never depend on language.
- No new subtitle parsing, ASR, background rendering or paid model calls.
- Windows ACL rollback repair and real Windows concurrency validation remain a separate Windows task; do not claim them fixed here.

## Review focus

- A hidden referenced source/group must retain prompt structure and actual inputs across edit/save/reopen.
- Main's hidden-source behavior, ports and cache fixes must coexist with timeline text and Windows execution-file protections.
- Minimum Pydantic must preserve omitted empty collections and old-document fingerprints.
- Every shared text/font bound must agree between backend enforcement and frontend preflight.
- Unsupported exports explain the reason without losing retained text or changing the saved project.

## Tasks

### Task 1: Integrate main while preserving both implementations

**Files:** Resolve actual conflicted source/tests/docs, regenerate `src/contracts/creation.schema.json`, `src/contracts/generated.ts`, `src/contracts/ruleFacts.generated.ts` from source.
**Interface:** Main's application ports/wiring, generated rule facts and typed commands remain authoritative; retain the published text and Windows files.

- [x] Create an integration branch from 0934583c, merge frozen current main and inspect every conflict.
- [x] Resolve source/tests deliberately; never hand-edit generated data to hide source conflicts.
- [x] Run contract generation, dependency-boundary tests and TypeScript/build checks; record remaining review failures before fixing.

### Task 2: Preserve hidden logical references through frontend editing

**Files:** `src/backend/creationClient.ts`, `src/backend/creationProjection.ts`, relevant canvas reference adapters and `tests/creationClient.test.ts` / projection tests.
**Interface:** Active business references and prompt parts survive hidden display items; visible canvas edges use a separate filter.

- [x] Add a failing test for hide -> read -> edit -> prepare -> save with follow_current and pinned/sourceVersion.
- [x] Verify the failure matches missing prompt/reference state.
- [x] Fix projection and write preparation; retain explicit reference removal and visible-edge semantics.
- [x] Run frontend suite and a real persisted backend/frontend round trip.

### Task 3: Fix dependency floor and shared timeline rule facts

**Files:** `pyproject.toml`, lock metadata if needed, `domain/rule_facts.py`, generator, timeline contracts/services/font parser, TS timeline validation/renderer/editor, related tests.
**Interface:** Export stable timeline/font limits through the existing generated facts; backend enforcement and frontend checks consume them.

- [x] Add a failing observable rule-facts/contract parity check, then centralize only business limits.
- [x] Require Pydantic >=2.12,<3 and verify empty-font/overlay serialization on the lowest supported version.
- [x] Regenerate contracts and run Python/TS boundary tests plus build.

### Task 4: Use stable bilingual error codes and explain unsupported exports

**Files:** Font/timeline/package services and errors, HTTP localization and shared CLI/Agent error adapters, `TimelineEditor.tsx`, bilingual messages and relevant tests.
**Interface:** Retained error code/details are stable; display language changes messages only. Unsupported FCPXML/legacy ZIP actions are disabled with a translated reason and editable-package/MP4 alternatives; backend rejection remains.

- [x] Add failing error-code/localization tests and an unsupported-export UI regression.
- [x] Replace exact-message translation with code-based lookup, preserving specific diagnostics at HTTP/CLI/Agent boundaries.
- [x] Add contextual disabled-action feedback in both languages.
- [x] Run i18n, backend error tests, frontend suite and representative browser checks.

### Task 5: Verify, review, publish checkpoint and hand off Windows

**Files:** `issue-87-validation.md`, PR metadata, a Windows handoff under repository development docs.

- [x] Run complete Node/Python checks, contracts, i18n, build and representative text/edit/export/browser workflows; report any known/environment failures separately.
- [x] Obtain one fresh review of this final change range, address important findings with regression tests.
- [ ] Commit reviewed task changes, run required upstream synchronization and fast-forward push the PR branch without force.
- [ ] Update Draft PR with actual shared fixes, new checkpoint and remaining Windows ACL/runner validation scope.
- [ ] Give the user copyable Windows instructions bound to the published checkpoint.
