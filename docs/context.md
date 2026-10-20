# Context

Everything needed to keep building this without re-deriving what was already settled. Read
`CLAUDE.md` first for the rules; this file explains *why* they are the rules.

---

## 1. What this is

A VS Code extension that reads local AI-CLI usage logs and turns them into a companion that
grows in the status bar. Claude Code and Codex are parsed from their own log files; nothing is
uploaded. The single network call is to PokéAPI for sprites and species data, at runtime.

**Origin.** Ported from [chattymin/PokeTokenBar](https://github.com/chattymin/PokeTokenBar)
(MIT), a macOS menu-bar app in Swift, at commit `12d4218`. The parsing engine and the
companion progression were translated to TypeScript; the UI was rebuilt from scratch.

**This is a derivative work, not a clean-room rewrite.** The 171 UI strings were extracted
from the Swift source with a script, the balance constants are theirs, and several comments
carry their measured numbers. `LICENSE` holds dual attribution and must stay.

**Not a fork of the repo.** History starts fresh here. The Swift tree lives in a separate
clone kept as the upstream reference (see §8).

---

## 2. Why TypeScript, and why it is not a Swift binary

The first design shared the Swift `Core` by compiling it and shipping a native binary in the
`.vsix`. That was the right answer while the goal was "make it work on my machine". It stopped
being right when the goal became "anyone can install it": supporting VS Code on Windows,
macOS (Intel and ARM) and Linux means **five platform-specific VSIX files**, each carrying a
~43 MB statically linked Swift binary, and it drags Swift-on-Windows back in — vendoring
sqlite3, static linking, ABI instability.

TypeScript collapses that to **one 63 KB artifact for every platform**. The cost is the fork:
~5,900 lines re-implemented, against an upstream that moves at roughly 4.6 commits/day and
added three usage providers in its first two months. §8 is what makes that survivable, and it
is not optional.

Three substitutions are what let it ship without native binaries. Do not undo them:

| Need | Swift did | We do |
|---|---|---|
| SQLite (deferred providers) | `import SQLite3` | **`sql.js`** (WASM). `better-sqlite3` is a native module and would bring back the five-target problem. |
| zlib | `NSData.compressed` | `node:zlib` |
| Credentials | Keychain, then file | **File only** — the Swift original already preferred the file. |

---

## 3. Measurements

These were taken against a real corpus of 970 MB of Claude logs (609 `.jsonl`) plus 494 MB of
Codex logs (5,729 files). They justify design decisions elsewhere in this document; do not
re-derive them, and do re-check them if you change the scan.

| | |
|---|---|
| Cold scan, first ever | **~30 s**, once |
| Startup with a warm on-disk cache | **~100 ms** |
| Steady-state refresh | **65–80 ms** |
| Packaged extension | **63.6 KB** |

**The incremental cache is required, not an optimisation.** If you code daily, essentially
every session file counts as "modified this month", so an mtime filter alone cannot avoid a
full re-parse. Without the cache, every refresh costs the 30 s.

**The worker must be long-lived.** A fresh worker per refresh reloads the cache snapshot from
disk each time (100 ms) instead of reusing it in memory (65 ms).

**WSL matters.** A stat-walk of 5,729 files takes ~110 ms natively but **~2,000 ms across the
`\\wsl$` / 9p bridge**, and does not improve with a warm cache. That is why `package.json`
declares `"extensionKind": ["workspace"]`: the extension host runs where the logs are. Changing
that line silently makes the extension ~17x slower for WSL users.

---

## 4. Layout

```
src/core/           No `vscode` import, ever. Unit-testable without the editor.
  iso8601           Date parsing. See §6 — do NOT replace with `new Date()`.
  models            ccusage-shaped DTOs, OAuth and Codex limit shapes
  modelPricing      Per-token USD rates
  tokenFormatter    compact / grouped / cost / percent
  appPaths          Platform data locations
  usageEnvironment  The ONLY reader of provider location env vars
  shellEnvironment  Login-shell fallback for those vars
  snapshot          The shape the UI renders, already formatted
  pokeapi           Species, evolution chains, hatch-candidate selection
  usage/
    entry           Entry, Bucket, aggregation, date windows, numeric coercion
    scan            mtime-windowed directory walk
    roots           Claude projects root discovery
    claude          Claude Code parsing
    codex           Codex parsing: forks, replay trimming, session-id probe
    cache           Incremental per-file cache
    gemini          PORTED BUT UNVERIFIED — no tests, not wired in
  companion/
    model           Rarity, balance, items, shop, evolution tree, nature, state
    persistence     Lenient decoding of the save
    ledger          Per-provider accrual — the densest defect-prevention in the codebase
    growth          Evolution, graduation, path repair
    shop            Purchases, items, candy grants
    display         Display state, egg progress, hatch rolls
    dexView         Pokédex, catch log, evolution strip
    saveTransfer    Export/import envelope, sanitising, device rebasing
    store           The only stateful piece: persistence and sequencing
  dev/simulation    Development-only scenario layer
  i18n/
    strings         GENERATED from the Swift source
    dispatch        Hand-written: switch-based entries and anything new

src/worker/         The scan. Never on the extension host.
src/webview/        Panel UI. Browser context: no Node, no core imports.
src/extension.ts    Status bar, timer, worker lifecycle, save export/import
src/panel.ts        Webview panel lifecycle and CSP
src/dev.ts          The simulation menu (one entry per scenario)
```

~8,000 lines of source, ~3,800 of tests, 375 tests across 18 files.

---

## 5. Invariants

Each of these has a reason that is not obvious from the code:

**`src/core/` never imports `vscode`.** Keeps the whole engine testable without launching an
editor. `test/usage-environment.test.ts` enforces a related rule mechanically by walking the
source.

**The scan runs in a `worker_thread`.** In the earlier design the parsing lived in a separate
*process*, so blocking did not matter. Here it would freeze the editor for 30 seconds.

**The core emits text already formatted and localised** — including the status bar string and
the tooltip. If the UI re-derives a number, that is a second source of truth, and it will
drift from upstream. The webview cannot import the core anyway (different bundle).

**Provider location env vars go through `usageEnvironment`.** A GUI-launched process does not
inherit the login shell, so reading `process.env` directly makes a user who exported
`CLAUDE_CONFIG_DIR` in `~/.zshrc` silently see zero — correct in the CLI, broken in the app,
irreproducible in tests. Two tests enforce this: one bans `process.env` outside an allowlist,
one bans the variable *names* outside their module.

**Sprites are fetched at runtime, never bundled.** Licence obligation. Keep the Pokémon
disclaimer in the README.

---

## 6. Traps that already bit

Written down because each cost real time to find and would be re-introduced by an innocent
"simplification".

**`new Date()` diverges from Swift.** Measured on Node 20:

```
".0344645678Z"   V8 gives .344    Swift gives .034
"2026-06-10"     V8 accepts       Swift returns nil
"+0000"          V8 accepts       Swift returns nil (needs the colon)
```

These values are `resets_at` and 5-hour block boundaries. `src/core/iso8601.ts` replicates
Swift's algorithm — truncate the fraction to 3 digits, then right-pad. Three tests fail if
anyone swaps it for `new Date()`.

**`JSON.stringify`'s array replacer is a recursive key allowlist.** Used it to sort keys when
exporting a save; it silently emptied the nested state. The worst possible bug in this app,
caught by its own round-trip test. `withSortedKeys` does it properly.

**`image-rendering: pixelated` only works at whole-number scales.** Sprites are 96 px. The
evolution strip rendered them at 34 px and they were unreadable mush; at 48 px (exactly half)
they are clean.

**Codex subagents are exempt from the timing fallback.** Removing that exemption broke nothing
in the test suite — a genuine coverage gap found by injecting the defect. There is now a test
with a matched control (same file shape, only `thread_source` differs).

**A zero-length parent prefix must not count as "parent found".** It would trim nothing *and*
skip the timing fallback, leaving a worse result than never finding the parent.

**The Ditto reveal is checked before terminal graduation.** Asset normalisation can turn a
disguised multi-form line into a leaf, and the wrong order graduates the disguise species into
the Pokédex.

**Day rollover opens known providers at 0, never drops them.** A provider missing from the
first refresh of a new day would otherwise have its cumulative value seeded as "already
granted" when it recovers, losing that usage. It heals at midnight, which is exactly why it
never looks like a bug.

**An unsatisfiable egg guarantee bricks the egg.** Legendary cannot be expressed via
capture_rate, so both roll paths find zero candidates, the guarantee is never consumed, and
buying another egg is gated behind having an active Pokémon. `sanitized()` drops it on load,
and `canBuyEgg` refuses to sell it.

**`sql.js` cannot see a `-wal`.** It opens a byte array, so a store in WAL mode read as of its
last checkpoint — and a writer that stays connected checkpoints only every ~1000 pages. On the
development machine, Copilot Chat's `session-store.db` was 4 KB of empty schema beside a 152 KB
WAL holding every row. This hit every SQLite provider, not just one: upstream links the native
`sqlite3`, which reads the WAL for free, so the gap exists only in the port. `wal.ts` folds the
log in (salt and checksum per frame, committed transactions only) and `withDatabase` reads the
WAL on both sides of the main file, using the pair only if the log did not move in between.
`test/usage-sqlite-wal.test.ts` builds a real uncheckpointed WAL with `node:sqlite` — `sql.js`
cannot produce one — and each of its guards was confirmed by removing it.

---

## 7. How to work on it

```bash
npm ci
npm run typecheck      # extension + webview: two tsconfigs, DOM only in the webview
npm test               # vitest, serial (fileParallelism false — fs-heavy suites hung)
node esbuild.mjs       # four bundles: extension, worker, webview js, webview css
npm run package        # .vsix
```

Press **F5** to launch an Extension Development Host. In WSL, verify the extension appears
under "WSL: Ubuntu" in the Extensions view, not "Local" — see §3.

**`Ctrl+Shift+P` → "Tokendex: simulación de desarrollo"** opens the scenario menu. It injects
synthetic tokens into the *observation*, so they travel the real pipeline (ledger, crediting,
growth, hatching, evolution, graduation) rather than poking state. Adding a scenario is one
entry in `SCENARIOS` in `src/dev.ts`; returning an array runs the steps in sequence.

Use "Guardar copia de la partida" before experimenting — the simulation mutates real state.

### Testing discipline

**Port or write the test first, then inject the defect and confirm it fails.** A test that has
never failed proves nothing. This is not ceremony: it is what found the Codex subagent gap
above, and what proved the ISO 8601 guards actually discriminate.

`test/usage-environment.test.ts` contains two mechanical guards that scan the source tree.
They are cheap and they catch a whole class of mistake; keep them working rather than
allowlisting around them.

---

## 8. Tracking upstream

The Swift source is **not** in this repo. It is kept in a separate clone, by default at
`~/dev-marty/PokeTokenBar` (remotes: `upstream` → chattymin, `fork` → diegomarty), pinned at
`12d4218`, the same SHA recorded in `PORTED-THROUGH`.

```bash
cd ~/dev-marty/PokeTokenBar
git fetch upstream
git log --oneline "$(cat ~/dev-marty/tokendex/PORTED-THROUGH)"..upstream/main -- Sources/PokeTokenBar/Core/
```

Port what applies, then update `PORTED-THROUGH`.

**This is the route by which new providers arrive**, not a maintenance chore. Upstream added
Antigravity, Copilot and Kiro in its first two months. Skipping this for a few months is how
the extension quietly becomes obsolete.

If you regenerate `src/core/i18n/strings.ts` from the Swift source, note that brand mentions
were rebranded to "Tokendex" after extraction — the extractor will reintroduce the old name.

### Where this port goes further than upstream

Upstream has no equivalent for these; a sync must not "restore" upstream behaviour over them.

- **Copilot in VS Code** (`copilot_vscode`, issue #2). Upstream reads only the Copilot CLI's
  `assistant_usage_events`. The Copilot Chat extension writes no token counts to disk unless
  `github.copilot.chat.otel.dbSpanExporter.enabled` is on; then it keeps OpenTelemetry spans in
  `<userDir>/globalStorage/github.copilot-chat/agent-traces.db`. What the reader relies on was
  read out of the extension's bundle (copilot-chat 0.66.0, built into VS Code), not from a
  published contract:
  - only `operation_name = 'chat'` is one model call; `invoke_agent` repeats the turn's total;
  - `input_tokens` is `prompt_tokens`, cached part included, so `cached_tokens` is subtracted;
  - a trace with an `invoke_agent` span whose `agent_name = 'copilotcli'` is a Copilot CLI
    session run from the editor; its `chat` spans are synthesised from the CLI's own usage
    events, which also land in `~/.copilot/session-store.db`, so they are left to `copilot`;
  - each span is its own transaction, children before parent, hence the 60 s settle window
    and the cap that keeps the watermark below the first unsettled row;
  - the store prunes spans older than 7 days and all but the latest 100 conversations at
    startup, so the cache merges on reset (`globalIDs`) instead of discarding.
- **WAL reading** (`wal.ts`), see §6.

### Pending review

Open items from the issue #2 work. Each is a question to answer with real data, not a known
bug.

- [ ] **Verify `copilot_vscode` against a real `agent-traces.db`.** Enable the setting, use
      Chat and agent mode, and compare Tokendex's numbers with the extension's own summary
      (`github.copilot.chat.otel.exportAgentTracesDB` exports the store). The test fixtures
      were built from the schema in the bundle, not from a captured store.
- [ ] **Confirm the Copilot CLI double count is real and is avoided.** Run a Copilot CLI
      session from the editor and check that it appears once under Copilot, not also under
      Copilot (VS Code). If the in-editor CLI does *not* write `~/.copilot/session-store.db`,
      the `copilotcli` exclusion under-counts instead and must go.
- [ ] **Inline completions.** Check whether ghost-text completions emit `chat` spans at all. The
      README only claims Chat and agent mode.
- [ ] **Re-check the bundle on Copilot Chat updates.** `agent_name = 'copilotcli'`, the column
      names and the pruning constants are internal. A changed schema reads as zero rows, not as
      an error — the failure would be silent.
- [ ] **Say when the data is unavailable** (issue #2's last acceptance criterion). Today it is
      the README only. A hint that fires when Copilot Chat was used in the window but no
      `agent-traces.db` exists would be precise; it must not be the red error banner, which
      would sit there permanently for everyone with Copilot installed and the setting off.
- [ ] **Premium requests** (the reporter's other possible meaning). Not in any local store
      Tokendex can read; it would need the GitHub API, which breaks the local-only rule.
- [ ] **Upstream commits since `PORTED-THROUGH` in the same reader file:** #187 (per-provider
      additional scan folders, Copilot included), #238 (Kiro 2.20 JSONL) and #289 (estimated vs
      unavailable cost). None is needed for issue #2; all three are unported.

### Wild encounter overhaul — open items

Mood (anger, nerves, trust), temperaments from base stats and nature, berries, attacks that
steal tokens, item finds, the legendary trail and a 30-slot queue with a "full" notice landed on
`fix/improvements-and-fixes`. The balance is pinned in `test/wild-encounters.test.ts` (`balance`),
solved exactly through the engine; change a constant and that table says what it did.

- [ ] **Play it in a real Extension Development Host.** The redesigned panel (battle screen,
      shop, bag pockets, Pokédex device, trainer card) was reviewed in the bench — the real webview
      bundle against real `buildPanelState` fixtures, dark and light, 280–920 px — and the throw
      was recorded frame by frame. Not yet looked at: the feed and attack animations in motion,
      a high contrast theme, and any of it inside VS Code itself.
- [ ] **Measure the queue on a real save.** The steady state for a heavy user was estimated at
      ~21 of 30; if it sits at 30 the "full" notice will fire after every expiry wave, and a
      minimum interval (`lastQueueFullToastAt` was considered) becomes worth adding.
- [ ] **Attack animation with the real move.** Deferred: it needs the move's localised name from
      `/move/{slug}` (one more cached, non-blocking request per species). The attack line falls
      back to "attacked you" today.
- [ ] **Disk cache for base stats.** In memory only; one extra request per new species per
      session. The types ride on the same `/pokemon/{id}` response, so they would be cached with
      them.
- [ ] **Terrains on old saves.** The scenery follows the primary type, which is kept from the
      spawn on. Encounters queued before types existed have none and keep their rarity scenery
      until they leave the queue; nothing backfills them, by choice — a request per queued
      Pokémon for decoration.
- [ ] **The wallet change on a real scan.** The `+12M` chip compares the balance with the last
      panel the worker built. Check that a cold start (first panel) shows nothing, and how often
      a heavy session shows one — every refresh that brought tokens in plays it.

---

## 9. Deferred, by decision

Scope was cut to Claude Code and Codex. Everything below is ported in the Swift original and
was deliberately left out:

- **Providers**: Gemini, Grok, Cursor, Copilot, Antigravity, Kiro, OpenCode.
  `src/core/usage/gemini.ts` exists but is **unverified and not wired in** — it has no tests.
  Either finish it (port `GeminiUsageTests`) or delete it; leaving untested code that looks
  finished is worse than not having it.
- **Official limit windows** (OAuth and Codex rate limits), and with them the free candy
  grants that fire when a window hits 100%. The grant logic itself *is* ported and tested
  (`shop.ts`), it simply never receives windows.
- **Multi-root providers.** From WSL, the Windows-side `.codex` and Cursor are invisible:
  `LocalUsageReader` pins `~/.codex` and Cursor's macOS path. `CLAUDE_CONFIG_DIR` accepts
  comma-separated paths, so Claude on both sides already works. Adding roots costs ~2 s per
  `/mnt/c` root per scan, so it must be configurable and off by default.
- **The floating pet** (486 lines in the original): opt-in, off by default, an always-visible
  animated window. The worst possible profile for idle cost.

---

## 10. Open decisions

**The Pokémon layer is both the borrowed expression and the IP exposure.** Nearly all the
copied creative content (translations, balance constants, game design) and all the Nintendo
trademark risk live in the same place. The parsing engine — the genuinely hard part — is
far less encumbered, because reading a log format is dictated by the format.

Replacing the progression with an original one would resolve both at once, and the game logic
was deliberately built as separate pure modules (`model`, `growth`, `shop`, `display`) to make
that a contained change. What would need inventing: what grows, at what thresholds, and how it
looks. **This is unresolved and was explicitly deferred.**

**Publishing.** Not yet on the Marketplace. `publisher` is `diegomarty`; the ID `tokendex` was
confirmed free. Publishing under a Pokémon-adjacent name with Pokémon sprites is a real
exposure on a Microsoft-operated marketplace with a takedown process. Upstream doing the same
on a personal GitHub repo is precedent, not permission. The name was chosen with that known.

**The status bar cannot show the sprite.** `StatusBarItem` accepts codicons only; custom
images have been an open request since 2019 (microsoft/vscode#72244). The animated companion
that defines the macOS app has no equivalent there, so the status bar shows a codicon plus
text and the sprite lives in the panel. Not fixable from here.
