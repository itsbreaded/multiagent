# 032 — Code Improvement Backlog (Index)

Findings from a five-agent review sweep across the codebase, originally ranked here as 49 items in four tiers. Every item has since been expanded into a complete developer-handoff spec (033–043), each re-verified against the code with corrected line anchors, phased implementation plans, tests, risks, and a handoff contract. **This file is now the index and execution guide; implement from the child specs, not from here.** Delete this file when all child specs are done or abandoned.

## Spec map

| Spec | Title | Original items | Tier / nature |
|---|---|---|---|
| [033](033-durable-persistence-and-safe-config-loading.md) | Durable persistence & safe config loading | 1, 19 | T1 correctness — atomic layout.json writes; validated provider/window-state loading |
| [034](034-pty-lifecycle-leaks-and-worker-crash-surfacing.md) | PTY lifecycle leaks & worker-crash surfacing | 2, 14, 15, 34 | T1/T2 correctness — tab-close kills PTYs; cancelled-create kill; worker-crash fanout; dead methods |
| [035](035-session-poll-pipeline-performance.md) | Session poll pipeline performance | 3, 4, 11, 24, 25, 37, 38, 41 | T1/T2 perf — SQLite tx/prepared stmts; cwd-stat dedupe; single-pass scanner; change detection; cache eviction; helper consolidation |
| [036](036-session-search-correctness-and-deep-search-performance.md) | Session search correctness & deep-search perf | 5, 7, 12 | T1 correctness — stale-generation fix; FTS5 escaping; DeepSearcher streaming/ordering |
| [037](037-renderer-render-performance-sweep.md) | Renderer render-performance sweep | 6, 16, 17, 18, 22 | T1/T2 perf — selectors, memoization, per-keystroke keymap rebuild |
| [038](038-identity-preserving-pane-tree-updates.md) | Identity-preserving pane-tree updates | 10, 39, 40 | T2 perf — updateLeaf identity contract; collectLeaves consolidation; removeLeaf cleanup |
| [039](039-browser-mcp-tool-honesty-and-arg-validation.md) | Browser MCP tool honesty & arg validation | 8, 45 | T1 correctness — closed-window methods throw; validated tool args |
| [040](040-typed-ipc-bridge-and-type-hygiene.md) | Typed IPC bridge & type hygiene | 20, 21, 27, 36, 43, 46 | T2/T3 type-safety — channel map completion; generic invoke/send; tsconfig includes; dep removal |
| [041](041-handlers-restructure-and-main-hot-path-fixes.md) | handlers.ts restructure & main hot-path fixes | 13, 23, 28, 30, 33, 47 | T2/T3 — async VS Code probe; byteLength removal; ack consolidation + file split; pty ownership guards; handler re-registration |
| [042](042-settings-panel-dedup-and-overlay-tokens.md) | SettingsPanel dedup & overlay tokens | 9, 26, 32, 42, 44 | T1/T3 — MCP form key remount; setting-row extraction; theme.ts overlay tokens; timer cleanup; search matcher |
| [043](043-panes-store-and-tabbar-structural-extraction.md) | panes store & TabBar structural extraction | 29, 31, 35, 48, 49 | T3 organization — panesIpc/focusArming/resumeIntoPane extraction; TabBar/App drag dedup; dead hook |

## Suggested execution order

1. **Quick correctness wins, independent of each other:** 033, 036, 039, and the Phase A portions of 034 and 042. All small, low-risk, immediately shippable.
2. **Perf pair:** 038 before 037 — identity-preserving tree updates multiply the value of the selector/memo fixes and 037's selectors assume 038's stability guarantees.
3. **Sessions:** 035 (phased internally; Phase A SQLite first).
4. **Type-safety:** 040 (item 20's channel-map completion is a prerequisite for the typed bridge; expect latent mismatches to surface — fix per-site, never loosen types).
5. **Structural refactors, one PR each, most invariant-dense last:** 043, 042 Phases B/C, then 041 (the cross-window transfer zone — e2e `tab:absorb` must stay green; follow its phase ordering strictly).

Cross-spec coordination notes:
- 037 and 038 touch overlapping call sites in `panes.ts`/`paneTree.ts`; land 038 first or coordinate in one branch.
- 043 Phase B (`findLeafByPtyId`, `resumeIntoPane`) touches the same listeners 038 patches (`session:detected`); whichever lands second rebases trivially.
- 041's file split moves the code 033 edits (`layout:save`/shutdown save → `layoutStore.ts`); land 033 first (it's small) so the split carries the atomic writes with it.
- Line anchors in all specs were verified at spec-writing time and will drift — re-verify before editing.
