# Tokendex — project instructions

A VS Code extension that reads local AI-CLI usage logs and turns them into a companion that
grows in the status bar.

## Architecture rules

- **`src/core/` never imports `vscode`.** It stays unit-testable without launching the editor.
  `test/usage-environment.test.ts` enforces a related invariant mechanically.
- **The scan runs in a `worker_thread`, never on the extension host.** A cold scan of a real
  corpus takes ~30 s; blocking that thread freezes the editor.
- **The core emits text already formatted and localised.** The status bar and the webview
  never re-derive or re-format a number — a second formatting path is a second source of
  truth that drifts.
- **Provider location env vars go through `usageEnvironment`**, never `process.env` directly.
- **SQLite goes through `sql.js`, never `better-sqlite3`.** A native module would mean one
  VSIX per platform, which is the whole cost this design exists to avoid.
- **Official limits never block a scan.** They are decoration; the totals are not.

## Extension points

Adding a provider or an install path touches a fixed set of places. Never grow a private list
somewhere else, and never add a `providerID === '…'` branch on a generic path (today/week/month
totals, burn tier, companion rhythm).

- **A usage source**: one module under `src/core/usage/`, one method on `LocalUsageCache`, one
  entry in the worker's provider list (both the `read(…)` call and the `sources` array). Root
  discovery goes in `roots.ts`; a location env var goes in `USAGE_ENVIRONMENT_NAMES`.
- **A version manager or install path**: `binaryLocator.commonToolDirectories()`.
- **An append-only SQLite store**: call `scanIncrementalStores` in `usage/additional.ts`. Do
  not copy the watermark loop.

## Testing

Write the test first, then **inject the defect and confirm the test fails**. A test that has
never failed proves nothing. This caught two real gaps: a `new Date()` that diverged in three
specific cases, and a missing guard on the Codex subagent exemption.

Reproduce the exact branch that triggers a bug. For an `A || B` gate, test **B alone** (A
false, B true) — a test that passes through a different path gives false confidence.

**Event-loop turns are not time.** Settling a fire-and-forget chain with `setImmediate` loops
flakes as soon as the chain contains real I/O (threadpool fs reads, subprocesses): 20 turns
finish in microseconds while the read lands on the wall clock. Wait for the condition with a
deadline; give negative assertions a real grace period.

When you fix a defect, sweep the codebase for the same _class_ of mistake and leave the
prevention behind as a test, a guard or a note — a mechanism, not a memory.

`src/core/i18n/strings.ts` is **generated**; edit `dispatch.ts` for anything new.

## Conventions

- Commits and PRs in English, using the gitmoji convention — see `CONTRIBUTING.md`.
- **No `Co-Authored-By: Claude` trailer.**
- Formatting is pinned in `.prettierrc.json` and gated in CI. Run `npm run format` before
  committing, and never run Prettier with a different config.
- Sprites are fetched from PokéAPI at runtime and never bundled — a licence obligation. Keep
  the Pokémon disclaimer in the README.
