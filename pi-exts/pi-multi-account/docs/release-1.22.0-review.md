# 1.22.0 backlog and release review

Date: 2026-09-17. Scope: all eight open issues, both community PRs, and accumulated local changes since 1.21.3.

## Profile and review priorities

TypeScript/Node ≥22 Pi extension, distributed through npm and GitHub Actions. Public contracts include host lifecycle hooks, OAuth/account files, provider streams and CLI commands. Highest risks are credential rotation races, competing session routing, incomplete Cursor tool streams, cache-prefix churn and publishing a locally-only build.

Reviewed domains: product behavior, host/API contracts, architecture, async/resource lifecycle, credential/privacy boundaries, persistence/concurrency, quota correctness, prompt-cache cost, regression tests, package contents, CI/trusted publication and documentation. Browser/mobile UI, databases and infrastructure deployment are not applicable. This is a scoped release review, not a claim of exhaustive security audit.

## Dispositions

| Item | Current relevance and decision | Evidence |
| --- | --- | --- |
| #51 shared lastUserModel | Still relevant. Pi-native session branch/launch model is authoritative; shared legacy preferences cannot restore on every input or overwrite shutdown defaults. Existing version-aware settings diagnostic retained. | Real Pi SDK session test and state-machine regression. |
| #52 billing-header version | Superseded by newer #57; both fixed with 2.1.274, verified against npm during preparation. | Constant extraction/header tests. |
| #54 context guard cache churn | Still relevant. Retain local safety cap, but measure already-elided outgoing context before adding a batch. Correct obsolete Pi compaction documentation. | Serialized-prefix sequence stays identical for small new turns; a later threshold crossing trims again. |
| #55 / PR #56 OAuth race | Accept and integrate author commits. Hold Pi credential lock across Codex exchange/persistence; waiting processes adopt the winner. Preserve shadow placeholder and sidecar. | Two real OS processes, one stubbed exchange, unrelated credentials preserved. |
| PR #53 SuperGrok usage | Accept and integrate author commits, resolving conflicts without dropping newer Cursor telemetry. Harden missing/malformed percentages to unknown, not invented zero usage. | xAI parser/header/401 recovery/startup/limits tests. |
| #57 billing-header version | Fixed together with #52. Weekly workflow now updates one issue, without trying a forbidden protected-main push or creating duplicate weekly alerts. | Workflow contract tests. |
| #58 GLM Coding Plan CN | Implement exact CN provider usage, not generic global zai routing. Fixed HTTPS endpoint, raw key authorization, explicit model-credit 5h/week windows, no MCP quota confusion. | Official zai-coding-plugins usage script confirms endpoint/auth; parser, fetch and accounts-refresh tests. |
| #59 per-model thinking | Still relevant. Manual model selection adopts host-applied default in auto mode. Forced configuration/explicit CLI thinking and automatic-failover effort preservation remain intact. | Real Pi SDK model-a low → model-b high → model-a low, plus existing CLI/failover tests. |
| #60 in-process subagents | Still relevant. Concurrent in-process sessions are passive while a root activation is live. Use a releasable lifecycle lease, not a permanent first-factory flag that breaks reload. | Real Pi SDK root/child/teardown/replacement test; child errors do not route independently. |

## Verification

- Synchronized local baseline: 575 tests passed before backlog integration.
- Both community PRs merged and tested in a separate worktree: 597 tests passed, TypeScript and package/privacy checks passed.
- Supported host dependencies aligned to Pi/pi-ai 0.85.1; no installed user runtime upgraded.
- Final release candidate: 603 tests passed, TypeScript and package/privacy checks passed. Linux CI exposed expected bounded `ELOCKED` contention in the saturated four-process test; its workload now retries asynchronously with a deadline. A separate regression proves the production 250ms lock bound fails without mutation and allows a later retry. Production lock timing was not relaxed.
- Fresh real-provider Cursor process completed native shell plus two reads and final response in 8.349 seconds. Trace included native `shellStreamArgs`, `exec.stream_closed`, `turnEnded`; no error or provider switch. Normal 60s/300s watchdog bounds, no fault injection. This is a capability check, not a reliability-rate estimate.
- Fresh combined extension startup (multi-account, broker and six other installed extensions): commands registered, no extension errors, isolated empty authentication store preserved.
- Final GitHub CI and trusted npm publication remain separate release gates; their results are recorded by the GitHub workflows and release.

## Residual risks and boundaries

- SuperGrok and Cursor usage interfaces are private provider contracts and may change. Missing data remains unknown; no live SuperGrok account was used in this release review.
- GLM CN wire shape is covered by fixtures based on the report, and endpoint/auth by official source. No live CN Coding Plan key was available for field verification.
- OAuth concurrency tests exercise real processes/storage locks with stubbed exchanges, not destructive live refresh-token races.
- In-process ownership is a conservative process-local policy: additional simultaneous SDK sessions are passive; separate OS panes remain independent. It is not a public host subagent-role API.
- No statistical reliability claim is made from one fresh Cursor run. The broader Cursor fixes retain deterministic lifecycle and shell-stream regressions.
