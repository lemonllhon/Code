# Memory topic top-k recall

## Behavior

When project memory is enabled, each eligible real-user turn may retrieve relevant topic files from the already-isolated project memory root. `MEMORY.md` remains a compact prefix index; recall adds bounded topic detail only to the current turn.

An eligible turn:

- has a non-empty canonical user query;
- is not `model-only` or an internal continuation;
- records a real user message;
- has an enabled memory root and `FileSystemPort`.

No positive lexical match means no recall attachment. There is no “inject the whole memory directory” fallback.

## Ownership and interfaces

- Persistent truth: existing files below the resolved project memory root.
- Derived cache: one `ProjectMemoryRecallIndex` owned by one `AgentRuntime`.
- Injection owner: `RegularTurnLoopState.turnRequestState`.
- I/O: only `FileSystemPort`; ranking code performs no I/O.
- No database, protocol, setting, or network dependency is added.

The index is keyed by file path and `mtimeMs`. Reconcile removes deleted/unreadable entries, rereads changed entries, and reuses unchanged content. Because `FileSystemPort.stat().mtimeMs` is optional, a candidate without `mtimeMs` is never considered cache-valid and is reread on every reconcile. A scan is bounded before per-file reads and uses fixed concurrency. Reconcile precomputes each document's term-frequency map, token length, and metadata token set; query-time ranking does not rebuild those structures.

## Ranking and budgets

- Candidate files: regular `.md` files except `MEMORY.md`, maximum 200. Symlinks are rejected and
  do not consume the candidate budget.
- Core traversal visits at most 128 directories and processes at most 4,096 directory entries.
  Each request passes the remaining entry budget through `FileSystemPort.listDirectory.limit`, so the
  Node adapter never accumulates more entries for that call than core can still accept. Core retains a
  defensive slice for alternate/test adapters. The directory queue uses a cursor rather than
  front-removal.
- Maximum indexed read per file: 64 KiB; maximum derived corpus: 4 MiB. The full read and manifest
  preview both pass the named per-file `maxBytes` guard. Stat results are admitted in stable path
  order until the corpus budget is full.
- Tokenization: Unicode-normalized Latin/number/identifier tokens, identifier sub-parts, and Han bigrams.
- Ranking: BM25 with `k1=1.2`, `b=0.75`; metadata receives a bounded boost.
- Stable ties: filename ascending.
- Default result count: 4.
- Maximum content per result: 4,000 characters.
- Maximum formatted attachment: 12,000 characters.
- A result must have a score greater than zero.

2026-10-18: bounded excerpts are centered on matching body paragraphs with adjacent context instead
of always returning the document prefix. Metadata-only matches retain the prefix. Runtime review
may reuse a frozen candidate selector without additional body reads; full target evidence remains
independently read and revision-checked. See agent-memory-learning-v2.md.

These are named constants. Changing them is a behavior change and requires updating this spec and its fixtures.

## Ordering and idempotency

```text
user persisted → turn state created → compact checks → recall once → provider request
                                                └─ same overlay reused by later model steps
```

Recall runs after any pre-request compact and before the first provider request. The attempt flag is set before I/O, so errors and retries cannot trigger duplicate work. The attachment is appended to the turn request only; it is not committed to canonical `messageHistory`, session storage, compact persistence, or cold-resume hydration.

Before micro, auto, or reactive compact, the exact `memory_recall` attachment is detached from the compact input. Summary generation and canonical replacement therefore never see it. A `finally` boundary reattaches the same overlay to the current turn request after compact success, skip, or failure, so later provider steps in that turn still receive it. Other `runtime_local` sources are not affected. The recorded model-request projection also filters `memory_recall`; the live provider projection retains it.

## Content safety and observability

The attachment says that memory text is background fact material and not higher-priority instructions. Provider wrapping continues through the existing system-reminder projection.

Expected absence (disabled memory, empty query, missing root, no match) is debug-level or silent. Recoverable scan/read failures do not fail the turn; a caught top-level failure is a structured warning with the current trace context. Logs contain counts, duration, output size, and a safe error name only—never memory text, filenames, absolute paths, or raw filesystem error messages.

## Extraction admission

The existing “minimum three user words” rule also counts Han characters as language units. This fixes Chinese sentences without spaces while preserving the English/number word rule. It does not change extraction scheduling, coalescing, model access, or write permissions.

## Acceptance cases

| ID    | Setup                                                     | Action                                      | Assertions                                                                                                                       |
| ----- | --------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| MR-01 | Relevant Chinese and unrelated English memories           | Query in Chinese                            | Relevant file ranks first; unrelated file is absent                                                                              |
| MR-02 | `workspaceIdentity`, `workspace_identity`, and path terms | Query an identifier form                    | Identifier sub-token matching succeeds deterministically                                                                         |
| MR-03 | Cached file                                               | Change `mtimeMs` and body, then recall      | New body is returned; stale body is absent                                                                                       |
| MR-04 | Cached file removed/unreadable                            | Reconcile                                   | Entry is removed and not returned                                                                                                |
| MR-05 | More than 200 candidate files                             | Recall                                      | Per-file work is bounded to 200 candidates                                                                                       |
| MR-06 | Multiple model steps/failover in one turn                 | Build requests repeatedly                   | One recall attempt and one overlay only                                                                                          |
| MR-07 | Second user turn                                          | Build next turn                             | Previous recall attachment is not in canonical history                                                                           |
| MR-08 | Large matching memories                                   | Recall                                      | Per-file and total character budgets hold                                                                                        |
| MR-09 | File contains nested system-reminder text                 | Project request                             | Existing wrapper sanitization prevents nested reminder markup                                                                    |
| MR-10 | Chinese sentence without spaces                           | Evaluate extraction admission               | It is eligible once it contains at least three Han characters                                                                    |
| MR-11 | Topic file larger than 64 KiB                             | Reconcile                                   | Full-read and preview requests carry the 64 KiB guard; recall cannot index more than the bounded read and the turn does not fail |
| MR-12 | Micro/auto/reactive compact after recall                  | Compact and build the next provider request | Summary, canonical history, and recorded model request exclude recall; the live request still contains the same single overlay   |
| MR-13 | Symlink sorts before regular topic files                  | Reconcile                                   | Symlink is never stat/read and does not consume the 200-file candidate budget                                                    |
| MR-14 | Candidate stats exceed 4 MiB total                        | Reconcile                                   | Stable admission stops at the corpus budget; excluded files are not read or cached                                               |
| MR-15 | Deep/wide tree                                            | Scan                                        | Core processes at most 128 returned directories and 4,096 returned entries using cursor traversal                                |
| MR-16 | Adapter omits `mtimeMs`                                   | Change a topic and recall again             | The topic is reread and refreshed; the missing timestamp is never treated as a stable cache revision                             |

## Out of scope

Session history search, automatic prior-session injection, vector search, database FTS, remote extraction, and subagent persistent memory.

The bounded contract limits adapter-side mapped entries; it deliberately does not promise snapshot
pagination or a globally lexicographic page. See `specs/file-system-directory-list-limit.md`.

Eliminating a list-to-read symlink replacement race likewise requires a no-follow/lstat or atomic
contained-read capability in `FileSystemPort`. P1 rejects symlinks reported by `listDirectory`; it
does not claim an atomic filesystem sandbox against another local process mutating the memory tree.
