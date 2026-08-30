# Changelog

## [0.2.2] - 2026-08-30

### Fixed

- Catching or running from a wild Pokémon now visibly shrinks the queue. Usage spent while the
  queue was full used to be banked (up to thirteen spawns' worth), so for a heavy user every
  resolved encounter was silently replaced on the very next scan and the waiting count never
  went down. A full queue now pauses encounter progress instead: a freed slot is earned back
  with a fresh threshold of new spend, never from a bank.
- The "Turn it on" prompt on the dev scenarios command wrote `tokendex.devMode` into the
  **global** settings, which the Extension Development Host shares with the real VS Code on the
  same machine — so a marketplace install there showed the Dev tab, looking exactly like a
  build shipped in dev mode. It now writes the workspace setting, which stays in the repo.

## [0.2.1] - 2026-08-29

### Changed

- New extension icon: the Pokédex device with Lugia, in pixel art. It replaces the abstract
  egg-and-bolt drawing, which the 0.2.0 marketplace listing shipped with.

## [0.2.0] - 2026-08-28

### Added

- **Wild encounters.** As tokens accrue, wild Pokémon appear — the first after 500k tokens,
  then one per 2.5M — and wait in a quiet queue (up to 12; a full queue banks further spawns
  until you make room). A badge on the activity-bar icon counts them; the only toast is a
  shiny or a legendary, at most once per hour, and `tokendex.encounterNotifications: "off"`
  silences even that.
- **One scene on Home.** Your trainer stands with the companion at their side (or the egg at
  their feet); a waiting wild Pokémon walks into the scene, and the capture happens right
  there — the classic arc, wobbles and outcome (the wobble count comes from the real Gen-IV
  catch formula on the species' capture rate). A miss can make the Pokémon flee, with
  escalating pressure per failed throw. Running away spends nothing. A catch files the
  species into the Pokédex marked as caught wild. Capture is the game's active loop, so it
  lives on Home — the panel's centre — not behind a tab.
- **Pokéballs in the shop**: Poké 5M, Great 15M (×1.5), Ultra 40M (×2), Master 1.5B (never
  fails), with ten-packs at 10% off for all but the Master Ball. A fresh save starts with
  five Poké Balls so the first encounter is playable.
- **Trainer picker** in Settings — 28 classic sprites, served by Pokémon Showdown at runtime
  like every other sprite (nothing bundled).
- Wild picks reuse the hatch selector's capture-rate weighting and thin out species already
  caught or queued, so the queue trends toward variety.
- Dev scenarios: spawn an encounter by rarity, fill the queue, grant balls.
- **First run**: a Getting Started walkthrough, a one-time welcome toast, a loading line while
  the first scan runs, and a friendly empty state naming the ten supported CLIs when no usage
  has been found yet.
- **The companion's sprite in the status bar tooltip** — visible without opening anything.
- The shop is grouped into Poké Balls / Items / Eggs with your spendable balance on top, real
  PokéAPI item sprites (emoji as fallback), the ten-pack's discount spelled out in its
  description, and unaffordable prices struck through.
- A compact companion card (portrait, stage, progress bar) stays on Home while a capture
  occupies the scene — the egg's incubation included.
- Per-provider burn (`/min`) column in the breakdown table while a session is active — the
  same number the tooltip shows.
- **Catch odds on every ball** in the rack, computed from the same Gen-IV maths the throw
  rolls — choosing a ball is a decision now, not a guess.
- **In-panel celebrations**: the hatch/evolve/graduate window finally reaches the page — the
  companion pops and sparkles in the scene (and in the compact card) alongside the toast.
- **Pokédex completion** — "24 / 649" with a bar above the species grid.
- **Refresh interval picker** in the panel's Settings, mirroring `tokendex.refreshInterval`.
- **Run asks first for what hurts to lose**: letting a rare, legendary or shiny go raises a
  native confirmation naming it; a common stays one click.
- An empty ball rack shows a real "Get Poké Balls" button into the shop, not a footnote.
- **The Pokédex is the full 649 now**: every slot renders, uncaught species as classic
  silhouettes with their number only — what is behind them stays a surprise. Clicking any
  slot opens a detail sheet pinned to the bottom of the view — visible wherever in the 649
  cells the click happened — with the animated sprite, number, name, rarity, catch dates with
  the wild badge, and a gold ★ for shinies (on the cell, the sheet and the catch log).

- **Catch difficulty retuned.** A capture-rate cap for every ball short of the Master (~84%
  best case) plus a global 0.85 difficulty factor: a 235+ common used to be a guaranteed,
  wobble-less catch with the cheapest ball. Every throw can wobble out now; the guaranteed
  catch is the Master Ball's job. Rare: 24% Poké / 41% Ultra; legendary: ~3.6%.
- **An animated hero GIF** in the README, recorded from the real shipped bundles (the capture
  choreography end to end), via a new `tools/bench/record.mjs` harness.
- **E2E smoke test**: CI now boots a real VS Code under xvfb, activates the extension and
  round-trips a refresh through the worker — `extension.ts` finally has a safety net.
- The panel builder moved into the core as the pure `buildPanelState` (14 new tests): the
  single largest piece of UI-shaping code is no longer outside the suite.
- A save-schema version is stamped into every save, so a future migration has something to
  branch on before it is too late to add one.
- The limit severity thresholds moved to the pure `limits/windows.ts` with boundary tests —
  they sat untested in the worker.
- Panel repaints skip byte-identical states and preserve the scroll position: the two-minute
  refresh no longer yanks the page while you browse the Pokédex.
- The Pokédex grid is one tab stop with arrow-key navigation (roving tabindex) instead of 649
  tab stops.
- Removed dead UI strings (`confirmBuy`, and Settings' misplaced "spend tokens to hatch" hint).

### Fixed

- The companion's idle bob animation never actually played — its keyframes were missing.
- PokéAPI failure backoff could double twice in one pass (hatch + encounter both failing),
  reaching the 30-minute ceiling in half the ticks it should.
- The throw's result line ("Gotcha! …") stayed on screen under the _next_ Pokémon that stepped
  up; it now belongs to its own encounter.
- An encounter from a previous day showed a bare time ("03:41 PM") that read as today; older
  ones now show the date.
- The native purchase modal's button said "Buy" in all four languages; it now uses the
  localised label.
- The status bar and its tooltip refresh right after a purchase, a catch or a language change,
  instead of up to two minutes later.
- The hidden Dev tab button was visible in production builds: the tab strip's own `display`
  rule overrode the `hidden` attribute, leaving a beaker icon over an empty section.
- A celebration sparkle could stay parked over the companion for up to a whole refresh
  interval: panel repaints reuse the last scan, which had the celebration state frozen in, and
  the sparkle's animation ended at full opacity. The window is now read live from the store and
  the sparkle bursts and fades.
- The Leaf trainer sprite never loaded — Showdown serves it as `leaf-gen3`; the whole roster
  is now verified against Showdown's live listing.

## [0.1.0] - 2026-08-20

First public release.

### Added

- **Status bar** led by the highest official limit percentage, falling back to today's tokens
  when no limit is known, plus the companion's mood as a codicon. The width stays stable
  between refreshes so neighbouring items do not shift.
- **Panel in its own activity bar view**, with the editor tab kept as the wide surface for the
  Pokédex. Both render the same page from one shared surface, so they cannot drift.
- **Compact companion card** that can live in the Explorer, in the sidebar above the panel, or
  in the bottom panel area — chosen with `tokendex.companionLocation`.
- **Usage parsing for every provider upstream supports**: Claude Code, Codex (fork replay
  trimming and session de-duplication), Gemini, Grok, Antigravity, and the SQLite-backed
  OpenCode, Hermes, Cursor, Copilot and Kiro. SQLite is read through `sql.js` (WebAssembly), so
  there is still one `.vsix` for every platform and no native module.
- **Official limit windows** for Claude and Codex, shown as bars in the panel and in the status
  bar tooltip, polled off the scan path so a refresh never waits on the network. Exhausting a
  window grants Rare Candy.
- **Incremental on-disk cache**: a cold scan of a 1.4 GB corpus takes ~30 s once, then 65-80 ms
  per refresh. Panel repaints re-render from the last scan instead of scanning again.
- **Companion progression**: egg incubation, hatching, evolution, graduation, shiny and Ditto
  rolls, Rare Candy / Mint / Shiny Charm, and guaranteed-tier eggs.
- **Evolution-line strip**: determined steps shown, an undecided branch collapsed into one
  mystery slot so the reveal is not spoiled.
- **Pokédex** split into a species grid and a chronological catch log, with the Pokémon being
  raised marked as not-yet-permanent.
- **Celebration notifications** when a companion hatches, evolves, graduates, reveals a Ditto
  or receives candy.
- Native confirmation before a purchase, and save export/import with a pre-import backup.
- Save transfer format with an envelope, so importing foreign JSON is rejected rather than
  silently replacing progress with an empty state.
- Four UI languages (ko, en, ja, es), tab labels included.
- **Development surface** behind `tokendex.devMode` (on automatically when running from source,
  off in a released build): a Dev tab of scenarios that inject synthetic tokens through the real
  pipeline, and a webview that repaints itself when the bundles rebuild.

### Notes

- Sprites and species data are fetched from PokéAPI at runtime and never bundled. Nothing else
  leaves the machine; usage comes from local log files only.
- The scan runs in a `worker_thread`, so it never blocks the editor.
- `"extensionKind": ["workspace"]` puts the extension host where the logs are. Reading a WSL home
  from Windows across the `\\wsl$` bridge was measured at ~17x slower.
