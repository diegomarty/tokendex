# Changelog

## [Unreleased]

## [0.3.0] - 2026-09-19

### Fixed

- **Wild Pokémon keep appearing again.** Two rules combined into a dead end: a full queue
  freezes encounter progress (0.2.2), and nothing but the player ever removed a waiting
  encounter — so a queue nobody tended became a permanent wall. Measured on a real save:
  twelve encounters arrived inside 34 minutes and the feature then produced nothing at all for
  the next 118 hours, across 561M tokens of work. Wild Pokémon now wander off on their own
  after six hours (a day for a shiny or rare-and-above, which would hurt to lose to a timer),
  so the queue drains by itself and encounters keep arriving. Same save, same burn, after the
  fix: 47 encounters over 24 hours instead of none.
- **A full queue no longer charges twice for the same encounter.** Progress was clamped to
  `threshold × free slots`, which with no free slots is zero — so a queue that filled up
  destroyed whatever the player had already earned toward the next encounter, and the slot
  they freed then cost a second full threshold. It is now held where it is, still capped at
  the one encounter it can honestly owe.
- **A disguised Ditto no longer freezes the companion.** The reveal emitted a growth event no
  caller handled, so a Pokémon that hatched disguised (1 in 128 of common lines with two or
  more forms) stopped dead at its first evolution threshold: no evolution, no graduation, for
  any amount of usage, for ever. The reveal now happens — the companion becomes the Ditto it
  always was, keeps its spend, and graduates into the Pokédex as Ditto for exactly what the
  line it impersonated would have cost. The reveal toast the shipped copy already had finally
  fires.
- **The persisted usage cache is actually used on the first scan again.** `ensureLoaded`
  flipped its "loaded" flag before awaiting the read, and the ten providers start together —
  so every provider but the first ran against an empty cache and wrote its freshly parsed
  blobs into maps the load then replaced. The cold parse the cache exists to avoid was being
  paid on every launch. Measured on this machine's corpus: a worker restart went from
  ~430 ms (identical to a cold start) to ~190 ms against ~900 ms cold.
- **Importing a save no longer credits a whole day at once, or changes the UI language.** The
  imported state was written verbatim, carrying the _other_ machine's daily ledger — so the
  next scan counted this machine's entire day as new usage — and its language. The import is
  now rebased onto this machine, which is what `rebasedForThisDevice` was written for.
- **An import can no longer be silently undone by a scan.** The worker holds the save in
  memory and writes it at the end of every scan; it is now stopped _before_ the file is
  touched, instead of restarted afterwards.
- **Export and import failures are visible.** A corrupt save or an unwritable target used to
  throw into a detached promise: no message, no log entry, a button that did nothing.
- **Old pre-import backups are deleted.** `BACKUPS_TO_KEEP` was declared from the start but
  nothing ever pruned, so every import — and every corrupt-save recovery, which repeats on
  each launch — left a file behind for ever.
- The usage cache is flushed when the window closes, so work parsed in the last minute of a
  session is not thrown away and re-parsed on the next launch.
- Turning `tokendex.devMode` off now stops the `dist` watcher instead of leaving it running
  until the window is reloaded.
- A Pokédex entry's badges are escaped once rather than twice, so a translation containing an
  apostrophe or an ampersand cannot render as `&amp;#39;`.

### Added

- **The compact card finally mentions the wild queue.** `tokendex.companionLocation` defaults
  to the Explorer, so the compact card is the surface most people actually look at — and it
  said nothing at all about wild Pokémon, which is how a queue sits full for days without
  anyone noticing. It now carries a row with the Pokémon on stage and how many are waiting,
  and opens the full panel when clicked.
- **The Pokédex can be searched.** 649 cells is roughly 217 rows in a sidebar, so finding one
  entry meant scrolling past everything else. There is now a search field (a name, or a number
  — a numeric query matches locked entries too, so you can look up #025 before you have ever
  seen it) and an "owned only" toggle.
- **The catch log can be narrowed by rarity.** Chips with per-tier counts, which is the filter
  `dexView`'s own comment claimed existed: the counter written for it (`dexCount`) had been
  sitting unused since the log stopped sorting by rarity.
- **The egg pre-rolls its species.** `pendingHatchID` was documented as removing the network
  round trip from the hatch moment but nothing ever wrote it. Past the halfway mark the next
  species is chosen and its evolution line warmed, so hatching no longer stalls the scan the
  status bar is waiting on.

### Changed

- **The status bar's hover card was rebuilt.** It now leads with the wild queue (a link
  straight into the panel), lays the per-tool numbers out as an aligned table instead of a
  ragged bullet list, and draws each limit window and the companion's progress as a bar with a
  severity dot — `percent`, `severity` and `progress` were all on the snapshot already and all
  ignored. A guard test pins every `command:` link in it to the host's three-command allowlist.
- **The panel renders only the tab you are looking at.** All six sections were rebuilt on every
  state push, so a refresh re-parsed the Pokédex's 649 cells for a tab nobody had open.
  Measured on the Home tab: 2,222 DOM nodes and 684 images before, 108 and 5 after.
- **The panel is navigable by screen reader.** The tab strip is a real `tablist` with `tab`
  roles, `aria-controls` and a roving tabindex (`aria-selected` on a bare button was not just
  useless, it was invalid); every progress bar carries `role="progressbar"` and its value; and
  a wild Pokémon arriving is announced through a live region that outlives the repaint.
- The word "tokens" in the hover card was hard-coded in English in all four languages — a
  Japanese user read `今日 · 253,400,000 tokens`.
- Wild Pokémon no longer overflow the ball rack: at sidebar widths the Run button was clipped
  off the right edge, which is the one control that costs nothing to use.
- The tab count badge is anchored to its icon. In an editor tab each tab is ~180px wide, so a
  badge pinned to the button's right edge floated halfway to the next icon.
- Every tab is reachable from the keyboard again. The tab strip gained a roving tabindex when
  it became a real ARIA tablist, which without arrow keys left five of the six tabs unreachable
  — half a mechanism is worse than neither. Arrows (and Home/End) now walk it, wrapping, with
  the panel following focus.
- The Pokédex search no longer breaks IME input. Rebuilding the field on every keystroke
  destroyed the composition with it, so in Korean and Japanese — two of the four languages this
  ships in — a name could not be typed at all.
- A tab painted before a ball was thrown is repainted after it lands. The state deferred during
  the animation was applied without invalidating anything, so the Pokédex could be missing the
  catch and the Bag still showing the spent ball until the next scan that differed.
- Closing a window no longer rewrites the whole usage cache when nothing was parsed: the
  shutdown flush skips the throttle, not the "is there anything to write".
- High contrast themes get their border back: the tab count badge was a black pill on a black
  editor background (only the white number survived, reading as a stray digit beside the icon)
  and buttons had no edge at all. Both now carry `contrastBorder`, which only high contrast
  themes define, so nothing changes elsewhere.
- The next-encounter line is one line again. It still opened by announcing the empty state —
  copy from when it was a standalone paragraph — which the empty scene above it already shows,
  and beside a bar with its own percentage that sentence wrapped at sidebar widths. It now
  reads `1.2M to the next encounter`, phrased like the companion's own `to next evolution`.
- An unaffordable price is dimmed rather than struck through — a line through a price reads as
  a discount everywhere else.
- Settings groups the save buttons under their own heading instead of leaving them flush
  against the trainer roster, and the egg screen's two progress bars are one component rather
  than two shapes for two meanings.
- The README's captures are regenerated from the current build, and regenerating them is now a
  command rather than folklore: `npm run readme:shots` and `npm run readme:hero`. The shipped
  images were showing copy, prices and a shop layout the extension had stopped sending — the
  still captures had no tool at all, and the GIF recorder looked for Chromium only under Linux
  paths, so it could not run on the machine that ships them.
- `npm run test:e2e` runs again. VS Code 1.110 renamed the macOS binary from
  `Contents/MacOS/Electron` to `Code`, which `@vscode/test-electron` 2.x could not find
  (`spawn … ENOENT`), so the end-to-end gate had been silently unrunnable on macOS with
  current stable. Upgraded to 3.1.0, which resolves the name; its Node floor moves the
  toolchain (and CI) to Node 22.
- `src/core/models.ts` no longer carries a second copy of the official-limit domain or the
  ccusage report parsers the port replaced. `src/core/limits/models.ts` is the one limits
  model; what remains is the aggregate shapes the usage layer shares.
- The worker and the save import derive "today's tokens per provider" from one shared helper,
  so an import can no longer anchor its baseline against a different set of providers than a
  scan credits from.

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
