# Changelog

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
