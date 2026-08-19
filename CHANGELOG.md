# Changelog

## [Unreleased]

### Added
- Status bar showing today's token usage and companion state, refreshing every 2 minutes.
- Panel with usage, companion, shop, bag, Pokédex and language settings.
- Claude Code and Codex usage parsing, including Codex fork replay trimming and session
  de-duplication.
- Incremental on-disk cache: a cold scan of 1.4 GB takes ~30 s once, then 65-80 ms per refresh.
- Companion progression: egg incubation, hatching, evolution, graduation, shiny and Ditto
  rolls, Rare Candy / Mint / Shiny Charm, and guaranteed-tier eggs.
- Evolution-line strip: determined steps shown, an undecided branch collapsed into one
  mystery slot so the reveal is not spoiled.
- Pokédex split into a species grid and a chronological catch log, with the Pokémon being
  raised marked as not-yet-permanent.
- Native confirmation before a purchase, and save export/import with a pre-import backup.
- Four UI languages (ko, en, ja, es).
- Save transfer format with an envelope, so importing foreign JSON is rejected rather than
  silently replacing progress with an empty state.

### Not yet ported
- Gemini, Grok, Cursor, Copilot, Antigravity, Kiro and OpenCode providers.
- Official limit windows (OAuth / Codex rate limits) and the candy grants that depend on them.
