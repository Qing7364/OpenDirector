# Generation impact: integration and validation

This records the dependency/reuse foundation for [#355](https://github.com/ThinkFlowLab/OpenDirector/issues/355). User-facing instructions and state meanings are available in both languages in the [CLI guide](../guides/cli.md). It does not establish completion of the full long-video workflow.

## Upstream boundary, checked 2026-11-23

- The isolated implementation starts at upstream `main` `52102ed03d74d08f52face27113fc9d44e283216`. No commits from the local issue-87 branch were carried in.
- [#342](https://github.com/ThinkFlowLab/OpenDirector/pull/342) was open at `f9993a1fb9db103ab028103859d26bdf93f4935d`. Its public patch provides H3 compilation, storyboard audit/QC and shot revision, not an adopted-input impact/reuse query. This change reuses existing execution snapshots, input resolution, asset verification and query dispatch.
- [#212's progress report](https://github.com/ThinkFlowLab/OpenDirector/issues/212#issuecomment-6821432061) describes a separate workbench service and editor document. The public branch/PR searches and the [interface request](https://github.com/ThinkFlowLab/OpenDirector/issues/355#issuecomment-7116407885) did not provide a runnable workbench branch or schema. No reply was present on recheck. Overlap with that unpublished implementation remains unconfirmed.
- Client and bilingual display strings are ready; visible workbench integration and a browser language-switch acceptance remain pending #212. No second workbench or speculative workbench document adapter was added.

客户端与双语词条已就绪，工作台可见接入待 #212 提供公共代码及真实契约；本记录不宣称完整 #355、真实 H3 生成质量或续写缓存恢复已验收。

## Shared integration contract

Use `generation.impact` through `POST /api/creation/projects/{projectId}/queries`, the existing Agent query tool, or `opendirector --project PROJECT_UUID query generation.impact --file impact-query.json`. The HTTP request uses the existing local-API request-header protection. No editing session is required.

- Query and report definitions: [commands.py](../../packages/core/src/opendirector/domain/creation/commands.py), [impact.py](../../packages/core/src/opendirector/domain/creation/impact.py), [generated TypeScript](../../src/contracts/generated.ts).
- Frontend: `CreationClient.generationImpact(rootSpecIds, { signal })` in [creationClient.ts](../../src/backend/creationClient.ts). It performs a read without installing the response as a project snapshot or entering the mutation queue.
- Display: pass stable states/reasons to `generationImpactText(code, t)` in [generationImpactText.ts](../../src/backend/generationImpactText.ts). Unknown codes have a translated fallback; no provider payload is rendered.
- Show both `inputState` and `reuseState`, the reasons and original `baselineJobId`/`activeJobIds`. Retain `projectVersion`, `eventCursor` and object revisions for context; they do not reserve a future edit. Any workbench action continues through existing commands with current versions, locks and authorization.
- Reports cover all project generation configurations. `relation` is relative to the requested roots; `timelineConsumers` covers only those roots and their downstream configurations. Fixed asset usage and source associations are review evidence, not automatic replacement instructions.

### Recorded request and response

The [request](fixtures/generation-impact-request.json) and [response](fixtures/generation-impact-response.json) were captured from `test_reopenable_dependency_case_uses_real_commands_and_files` after editing B's prompt. These UUIDs belong to an isolated test project; substitute IDs from your own project to execute a query. The HTTP sample includes the envelope; the CLI parameter file contains just `rootSpecIds` and optional `maxNodes`.

| Test object | Spec ID | Current inputs | Reuse | Relation |
| --- | --- | --- | --- | --- |
| A | `d2f677d8-e6cd-43c8-ae54-8df7734c28fa` | equal | reusable | independent |
| B | `4d5f438a-f86f-4f0f-b9aa-7d6e6cebeeef` | changed | stale | root |
| C | `dee2d143-046b-47fc-86f3-1c24f113c236` | equal | pending_upstream | downstream |
| D | `7f268b78-755a-433e-8751-cdf17259877d` | equal | reusable | independent |

A is an upstream dependency of B, but is not downstream of the requested B root. The timeline contains B/C/D; the response lists B/C consumers with their retained assets and source associations. D remains outside the requested downstream scope. The report contains IDs, fingerprints and controlled field paths, not prompts, provider URLs, credentials, local paths or raw adapter data.

## Coverage decisions

Current active `follow_current` references determine propagation. Pinned inputs, overrides, candidates, display changes and historical Job usage do not create spurious live edges. `context_only` inputs do not propagate future upstream changes; the existing shared fingerprint still decides their current equality after actual adoption.

Subject slots retain assets in their editor document. Their `inputConnections` do not establish live generation-follow semantics. The report keeps document/item/asset evidence without inferring upstream specs from identical bytes or old provenance. Any future #212/#354 slot adapter must explicitly define its live binding semantics.

The comparison uses the same frozen inputs as generation acceptance. Known adapter output settings and generated random seeds remain execution facts. Unknown adapter extension fields or missing saved model rules prevent a reuse claim. Current storage has no reconstructable guide/window/direction plan for external workflows; a future persisted field needs explicit comparison coverage. `reusable` means the registered existing output can be reused under the compared inputs, not a remote cache hit or deterministic new generation.

Inputs are bounded to 100 distinct roots, at most 10,000 configurations (default budget 2,000), and 20,000 active references/expanded edges. A limit error returns no partial success. Unresolved dependencies and cycles remain explicit uncertainty, including dependent nodes; no execution order or retry command is invented.

## Reproducible validation

Run with Python 3.12 and the Node version in `.nvmrc`, using the [validation guide](validation.md) for setup:

```bash
PYTHONPATH=packages/core/src:apps/api/src:tests .venv/bin/python -m pytest tests/test_generation_impact.py tests/test_generation_impact_queries.py -q
node --test tests/generationImpact.test.ts tests/creationClient.test.ts
.venv/bin/python scripts/generate_contracts.py --check
PYTHONPATH=packages/core/src:apps/api/src .venv/bin/lint-imports
npm run check:i18n
npm run build
```

The Python scenario uses real small PNG files, real command acceptance, immutable Job inputs, candidate generation, result adoption, pinning, timeline creation and a fresh project service after reopen. Only model execution is doubled. It verifies query equality across HTTP/Agent/CLI, file and project immutability, one project/catalog read, unavailable output files, foreign-project roots, limits, cycles and a 1,200-node graph. Frontend tests switch the active locale through English and Chinese for all declared report codes and verify typed read behavior while a newer project snapshot arrives.

No live GPU/commercial provider was called. The workbench UI, native visual Harness matrix, browser export and remote continuation caches are separate acceptance scopes; they are not proven by these fixtures.
