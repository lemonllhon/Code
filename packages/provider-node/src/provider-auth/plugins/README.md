# Fixed provider compatibility

The worker bundles the pinned modules recorded in `../vendor/manifest.json`. It is
isolated per authorization attempt/account. Renderer input cannot select a module,
read a local path, provide credential callbacks, or access the fixture transport.

The local compatibility code preserves method metadata and safe model capability
facts, reports model-list fallback and sign-in state to the Host, and runs Factory
file imports through the existing authorization attempt. Plugin-owned grant fields
and imported file contents stay private to the Host worker.

Upstream-derived adaptations added outside the pinned directory:

| Local file                             | Exact source                                                                                | Revision / license                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `factory-import.mjs`                   | Magpie `internal/provider/factory_key.go` and pinned Factory `whoami` response/grant format | Magpie `93c5d846ca2b05ac8ca961956304104e5d112845`, MIT (`../native/LICENSE.magpie`) |
| `method-details.mjs` (`promptApplies`) | Magpie `internal/plugin/host.js`, `applies` / `nextPrompt`                                  | same Magpie revision and license                                                    |
| `zcode-local.mjs`                      | plugins `packages/zcode/index.mjs`, credential decryption and `ownSignIn` / `ownTeam`       | plugins `da7e2f67a5c7c2fe2ca776156d08ce2f144e86dd`, MIT (`../vendor/LICENSE`)       |

The ZCode adapter reads only the selected site's local source without modifying
the pinned module, process-wide environment, or external credential files. It
materializes that site into a `zcode-channel` grant for each actual operation.
Renewal follows only the same account, organization and project; identity changes
require detecting the account again, so usage cannot move into an old connection.
Signing out retains the pinned plugin's snapshot fallback.

The upstream-derived files listed above, as well as the generated worker, belong
to the copied component inventory. Regenerate the bundle with
`node scripts/build-auth-plugin-worker.mjs`, then regenerate and verify notices.

Account check-in protocol rules in `checkin.mjs` follow Magpie `707fbb249df755423d3b2b77c6f001dd376d75c4`, MIT (recorded in `third-party/copied-components.json`). Billing and promotion facts remain operation-scoped read-only projections. The fixed plugins are updated to `5d5d86e2251169e0f5c0fd7a884957ac2dbe184a`; the earlier revision cited for `zcode-local.mjs` above records that separate adaptation's source.

## Bounded compatibility backports (2026-10-20)

The immutable vendor snapshot remains at `5d5d86e`. After verifying its hashes,
the worker generator applies `vendor-compatibility-patch.mjs` and the Devin/Zed
patch helpers to its in-memory copy. Exact source matches fail closed on drift.
The adapted protocol behavior comes from community plugins
`5b68df0057501d67b3eda711800ad57254634a58` (MIT, retained `../vendor/LICENSE`):

- `packages/qoder/index.mjs`: wrapped 10605 busy, whitespace in stream bodies,
  and model-list errors; `packages/zen-free/tool-response.mjs`: nullable deltas.
- `packages/factory/index.mjs`: unsupported OpenAI Responses sampling fields.
- `packages/devin/index.mjs`: tool-result images and their exact source markers.
- `packages/zed/index.mjs`: usable organization selection, per-organization
  model-token identity and accurate organization plans. Local integration awaits
  the existing Host credential CAS on catalog/quota refresh and does not replay
  inference when an organization is refused.
- `packages/workbuddy/index.mjs`: explicit credit-unit suffixes.

The original cache-usage patches still apply afterward. Cursor continuity,
check-in hooks, SDK parsing, tool execution, history and memory are unchanged.
The separate backport provenance is registered in `third-party/copied-components.json`.

## Cross-platform backports (2026-10-22)

Additional bounded adaptations follow plugins
`7ee60f825387455db26157ade2740a0f4ddbf3ee` (MIT, same retained vendor LICENSE):

- `vendor-qoder-session-patch.mjs` derives tool-pairing, cache marking and Windows
  machine-wide runtime discovery from `packages/qoder/index.mjs` (`a900bab`,
  `dc59000`). Local pairing never assigns an unknown explicit result to a call
  whose ID was already known. Calls without matched results remain explicit
  historical text, so neither side leaves an invalid protocol pair. Cache identity uses the existing Host ticket's
  `AuthDriverContext.requestSessionKey` (the existing workspace/remote-session/session
  tuple, with a legacy local session fallback) or an explicit cache key; missing identity
  gets a request-local ID, never a prompt/user-derived conversation guess.
- `vendor-devin-empty-patch.mjs` derives pre-success empty-reply rejection from
  `packages/devin/index.mjs` (`397a890`). Local integration also owns cancellation
  of pending reader IO, first-frame errors and stream-end errors. No extra model
  POST is introduced; retry decisions remain with the existing Runner.
- `vendor-compatibility-patch.mjs` also adapts incremental IDs from
  `packages/zen-free/tool-response.mjs` (`ec884d0`), billing-header line removal
  from `packages/factory/index.mjs` (`bb020ce`), and absent-tools choices from
  `packages/grok/index.mjs` (`aee6b9d`).

The Windows runtime probe also preserves macOS/Linux and CLI fallback branches.
Its injected Applications root is test-only and is never accepted from Renderer.
Host account admission distinguishes Kiro login providers using the existing
composite identity mechanism; Devin's distinct private API keys already remain
separate, even when their display email matches.

The broad Qoder upstream-error-to-502 conversion and internal queued POST resend
are deliberately excluded: deterministic schema 400 errors and the single physical
attempt guarantee retain their existing semantics. There is no new provider, queue,
credential owner, desktop/mobile delivery kind or WebKitGTK platform dependency.
See `specs/provider-plugin-backports-2026-10-22.md` for acceptance and validation.

Follow-up review at plugins `1b06308fad9386171c25f377d3ff8fcc4d4f3757` and
magpie `95be6bb75f6128318619c450f0584696a5ba888e` adds bounded adaptations in
`vendor-followup-patch.mjs` and `vendor-minimax-checkin-patch.mjs`: Kiro API key
control-plane discovery (`2039678`), Zed inline system projection (`3d355d3`),
Devin Connect compression (`4fd68ba`), MiniMax account signing and one renewal
(`4d73d22`, `532e738`), Trae reasoning/name deltas (`40d7c52`), and Qoder's
browser-only device flow (`f5548bd`), and new Trae CN device ID shape (`63a3d2a`)
without rewriting existing device bindings. MiniMax uses its native account helpers;
the incomplete generic MiniMax check-in fallback and header-only signer were
removed. Check-in results remain the strict shared reply; only the original
Host credential channel receives sign-in facts.

Factory's precise `content_policy_rejected` 403 is normalized before the plugin
can reconcile organizations: HTTP 400 retains the body/code and records the
original status in `x-lcode-upstream-status`. Other 403s and an explicit
`x-factory-upstream-error` retain their original handling. The public provider
classification also preserves structured Responses filter failures in HTTP
and SSE; it does not search user text for refusal words. Magpie's new refusal
handling informed this boundary; its account fallback policy is not copied.

The HTTP projection lives in the public `provider-node/src/content-refusal.ts`
and runs before plugin protocol conversion, Host account feedback, and ordinary
API key lease feedback. Native OAuth drivers, fixed plugins, and OpenAI,
Anthropic and OpenAI-compatible key pools share that implementation. A content
refusal cannot first disable a key or switch accounts before the SDK reads it.
Ordinary authentication/quota failures retain their existing behavior; Factory's
upstream-error exception is defined once in the shared projection.

CLI process cleanup now belongs to the parent transport and uses the same
public Node process-tree implementation as MCP. The worker reports only
actual child PIDs; parent cleanup survives worker failure. POSIX process groups
are signalled only when explicitly owned. See
`specs/provider-followup-2026-10-22.md` for the review matrix and verification limits.
