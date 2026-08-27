# Changelog

## [Unreleased]

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
- A slim companion-progress strip stays on Home while a capture occupies the scene.
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
