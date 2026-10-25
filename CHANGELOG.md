# Changelog

## [Unreleased]

### Changed

- The Marketplace and Open VSX listings describe Tokendex as it is now: a Pokémon game and a
  local usage tracker, instead of the early status-bar creature.

## [1.1.1] - 2026-10-25

### Fixed

- **Turning sync off stops it at once, in every window.** The window that was syncing used to
  carry on for up to two minutes, and a round already under way could still upload.
- Signing in to VS Code with another GitHub account no longer keeps syncing with the first
  account's gist.
- A computer whose copy in the gist was out of date now replaces it, instead of waiting for
  something to change locally.
- A computer's save that failed to download is retried on the next round, instead of being
  skipped until the gist changed.
- A refused GitHub sign-in shows one message, not two.

## [1.1.0] - 2026-10-22

### Added

- **One game on every computer.** Sync is opt-in, per computer, through a secret gist in your
  own GitHub account and VS Code's GitHub sign-in. Every computer publishes its own save and
  merges the others' every few minutes: the Pokédex and all the usage each machine counted are
  kept, and one companion continues. The first time, when both computers already have a game,
  you choose which companion that is. Both computers can be in use at the same time: the tokens
  each one counts reach the other without either game replacing the other. A computer whose
  companion is replaced by another's keeps a backup, apart from the import backups. Today's
  usage counter and the display language stay with each machine. The trainer you pick now
  travels with the game, on import-merge too.

## [1.0.0] - 2026-10-21

### Added

- **Every species has its own registration bar.** The tokens your companion uses are its
  experience, and filling a species' bar registers it in the Pokédex and evolves the companion
  into the next form, which starts its own bar; you can always go back to an earlier form. A
  full Pokédex now costs about 46.5B tokens (every line's total divided by fifteen), so it
  takes an average user one to two years rather than decades. Tokens still count twice: each
  one is experience and balance, and spending never takes experience away. A Rare Candy is
  worth a quarter of the current stage, two per species at most.
- **You choose your companion.** A new game starts by picking one starter from generations
  1–5. After that, the companion can be any species you have obtained, or an egg: a free egg
  arrives every day (up to three in stock) and 5M tokens hatch it. The shop's eggs add a
  guaranteed tier, and the egg itself can be bought into the stock. A PC box lists every
  obtained species, unfinished first, with search and sorting, to switch in two clicks.
- **Catching registers.** A first catch obtains the species and fills 5% of its bar; a
  duplicate pays tokens instead (2M common, 4M uncommon, 30M rare, 40M legendary). Evolved
  forms appear in the wild at the games' odds (65/30/5 for three-stage lines, 75/25 for two),
  weighted toward what you are missing, and a Poké Ball on the wild Pokémon's card marks a
  species you already have.
- **Shinies are earned.** Once a species is registered, its experience fills a shiny bar
  eight times its line's total; tokens can buy up to half of it. Catching or hatching a shiny
  still completes it at once. A Shinydex counts them.
- **A lure** aims a day at one species you have seen: its line weighs forty times more in the
  wild draw for 24 hours (20M common, 50M uncommon, 150M rare; no legendary lure).
- **Medals, regions and challenges.** Medals for registered species, shinies, catches, a line
  raised to its end and each region (Kanto to Unova) are announced once. Two daily challenges
  and one weekly one pay 5M and 40M; they are the same on every machine and paid once, even
  across merged saves. The Pokédex filters by region.
- **Every species card is a Pokédex entry.** The sprite on the device's screen, its genus, types,
  height and weight, the Pokédex text written letter by letter, base stats as bars and the
  evolution line, each form a way to its own card. Read from PokéAPI when the card first opens
  and kept on disk, so it opens offline afterwards; a species only seen shows its genus and
  types, and the rest comes with obtaining it.
- **Packs from ×10 to ×100.** The ten-pack has ▲▼ beside its price, so a big restock is one
  confirmation at the same 10% off.
- **The PC box filters and both lists turn around.** Registered, still to register, shiny and
  region chips in the PC box, and an arrow beside every sort to reverse it.
- **The Pokédex search finds every species by name**, met or not: the names are read once from
  PokéAPI and kept on disk. A species not met yet still shows as a silhouette.

### Changed

- **Home is one panel.** Eggs, challenges, the legendary trail, wild Pokémon, finds, the
  streak and the shop fold into drawers with one-line summaries; usage lives on the device's
  lid, whose lights read the official limits. Tabs are the device's buttons, drawn with game
  items, and fade between views. Every bar, button and empty state is drawn one way, and every
  empty view says how it fills.
- **The battle menu is Pokémon · Bag · Run.** The Pokémon button opens the companion's card
  over Home; mood bars on the wild plate are icons that animate when they change; the dialog
  writes letter by letter (instant with reduced motion, and screen readers get the whole line).
- **Celebrations are drawn in the panel.** A hatch, an evolution, a registration, a medal or a
  candy grant shows as a card in the panel when it is on screen, one after another; only when
  no panel is visible does it become a notification.
- **Shop prices follow the new scale:** tier guarantees 50M and 80M, Rare Candy 150M, mint
  30M. The economy is tuned with a simulator that drives the real engine.
- **Existing saves start the new registry at 0%.** Every species you had is obtained, your
  companion stays the same, and your balance and catch history are untouched.
- Buttons say what they do: the ways to the shop say "Shop", and Japanese uses the games' verbs
  (かう, つかう, にげる).
- The Shop and Pokédex heads are the same device as Home's lid, titles in the logo's capitals,
  and the Pokédex's segments, search and filters fold into it.
- Home's Wild drawer lists the next three in rows with their party icons, then how many more
  wait. Bag pockets are never greyed out: an empty one says how it fills.
- The battle dialog writes itself letter by letter in every encounter, not only the first.
- The Shinydex shows the shinies you have obtained, its region chips count shinies, and the
  Pokédex grid is a list of entry cards that scrolls on its own and keeps its place between
  Collection and Shinydex.
- Every experience and registration bar is the companion plate's EXP bar: Pokédex cells, the
  species card, the PC box, the catch card and the news. A registered species' bar turns green.
- The species card opens over a veiled Pokédex: its facts and evolution line first, the game's
  part next, its Pokédex text and base stats last. Its registration reads on one line — the bar,
  and the date the species was registered.

### Fixed

- A registered species' catch card showed an empty green pill: its text was painted the pill's
  own colour. It reads "+5% registered" again, and a test keeps a pill's colours its own.
- **A window still on an older version can no longer wipe your progress.** It rewrites the save
  without the keys it does not know, and the registry used to be rebuilt from scratch when read
  back. The registry and the rest of the new game are now kept beside the save and restored.
- Choosing a companion at an evolved form (a caught Charmeleon) no longer marks the forms before
  it as obtained.
- A Ditto's reveal no longer takes away a species you already owned, and switching away from a
  Ditto still in disguise reveals it rather than leaving the species it showed shiny.
- The automatic move-on no longer undoes a companion you had just chosen in another window.
- An egg's guarantee can only be upgraded, never bought twice or downgraded.
- Merging saves pays a challenge only the other machine had completed, instead of losing it.
- A Rare Candy is never spent without its experience.
- A lure never makes a first form less likely within its line.
- The Pokédex reads complete only when nothing is missing (646 of 649 used to show 100%).
- A shiny caught before shiny bars existed now appears in the Shinydex.
- A species card refreshes when what you own changes, and says so if its entry cannot be read.
- A species card no longer flickers: it opens once at its full size, and pictures are kept
  across repaints instead of reloading every time a button answers.
- The companion on stage no longer shows up in the catch log, which records catches and
  graduations only.

## [0.5.0] - 2026-10-20

### Added

- **Wild Pokémon have a mood, and berries to change it.** Every encounter now carries a
  nature and a temperament drawn from the species' real base stats (`/pokemon/{id}`, fetched
  with the species and cached), and three meters the plate shows as gauges: anger, nerves and
  trust. A missed throw raises anger and nerves and costs trust; anger lowers the catch value
  and, past a point, makes the Pokémon strike back and take some of your spendable tokens
  (common 500k up to legendary 4M, three times at most, never below zero — and all of it paid
  back if you catch it); nerves decide whether it flees. An Oran Berry calms it and earns
  trust, a Nanab Berry settles its nerves, a Razz Berry makes the next ball easier. The odds on
  each ball already include the mood, and the dialog says what a miss risks, so the number you
  read is the number that is rolled. Berries are sold in the shop singly or in ten-packs.
- **A legendary that gets away leaves tracks.** One that flees or wanders off can be followed
  for 72 hours — the same Pokémon, nature and temperament, back in the queue a little more
  nervous — for 100M, then 200M, then 400M; running from it on purpose leaves nothing. The
  catch cap moved from 200 to 250 so Great and Ultra Balls matter against commons too; with
  neutral temperaments the final odds are 13 / 18 / 23% on a capture rate of 3 and
  59 / 70 / 77% on 45, both pinned in tests.
- **Items turn up in the wild.** A quarter of arrivals are finds rather than Pokémon — balls
  and berries by rarity, never a Master Ball or a candy — collected with a click. The queue
  holds 30 (Pokémon and finds together, up from 12), and the first time it fills a toast says
  so, once; it re-arms when room is made.
- **Saves merge across machines.** Each install mints a device id, every token is attributed
  to the device that counted it, and each save carries a revision vector. Importing a save from
  another computer now offers **Merge** as well as Replace: both Pokédexes and all the usage
  either machine counted are kept, the companion, bag and queue continue from whichever save
  progressed more, and today's ledger and the display language always stay with the machine.
- **Copilot Chat in VS Code counts** when the extension's opt-in
  `github.copilot.chat.otel.dbSpanExporter.enabled` is on: its `agent-traces.db` is read like
  the other SQLite stores (chat spans only, cached tokens subtracted from the prompt, the
  in-editor CLI excluded so it is never counted twice), with a 60-second settle window because
  the store is written in batches. The README documents the setting; nothing is on disk
  without it.
- **A Makefile** wraps the day-to-day commands (`make check`, `make test FILE=…`, `make dev`,
  `make shots`, `make bench-run SCRIPT=…`).

### Changed

- **Home is a battle screen.** Your trainer and companion on one side, the wild Pokémon on its
  platform on the other, each with a paper-and-ink plate; a dialog box; and the balls as one
  row of tiles with Bag and Run beneath — a throw is one click, not two. The scenery follows
  the wild Pokémon's primary type (eighteen terrains, drawn in CSS so nothing is bundled) and
  fades from one to the next; an encounter from before types were kept stands on the terrain of
  its rarity. Every sprite renders at its true size, legendaries at the top of the scale. The
  stage no longer flickers when you open Balls or change tab: the entrance plays once per
  encounter and sprites keep their nodes across repaints.
- **Your balance heads the page** on a Pokédex lid — lens, lights, the name — with the spendable
  tokens on its screen. A change arrives as a chip beside it: green sliding in when a scan
  brings tokens, red sliding out when a Pokémon steals some or you buy something; a state
  re-sent to the panel never replays it. The shop wears the same screen, single balls and
  berries buy in one click (packs, eggs and the Master Ball still ask), and the bag has pockets.
- **The Pokédex is a red device** and Settings is a trainer card. With a dark editor theme the
  plates, menu, shop and card use dark paper; in high contrast every bar fill is drawn in
  `CanvasText`.

### Fixed

- **SQLite stores in WAL mode are read in full.** `sql.js` opens the main file as bytes, so a
  store whose writer had not checkpointed read as of the last checkpoint — on the development
  machine, Copilot's session store was 4 KB of empty schema beside a 152 KB `-wal`, and Codex's
  whole schema lived in the WAL. The `-wal` frames are now folded in (sizes checked before
  reading, a consistent snapshot with a retry), and the result was checked against `sqlite3` on
  real stores.
- The companion store sets the owed-legendary cap from its own constant rather than the queue
  size, so raising the queue to 30 did not also raise how many legendaries can be owed.

## [0.4.0] - 2026-09-19

### Added

- **A streak or a spending milestone now summons a legendary.** Three days of accrued work
  inside a rolling seven, or every billion tokens used, each owe one legendary encounter.
  Three consecutive days _are_ three days within seven, so there is one rule and one award per
  window rather than two that would pay twice for the same week — and days are recorded only
  where a refresh actually credited usage, so it counts work rather than an open editor.
  Forcing a legendary used to be impossible: the species index carried a capture rate and
  nothing else, which is why a legendary egg could not exist. The two legendary flags now ride
  the existing index query — two columns, once every thirty days — and an index cached before
  they existed is treated as expired rather than deleted, so the pool comes back empty and the
  reward waits instead of handing over an ordinary rare. The legendary itself gets no special
  treatment: it flees like any other, and it is still roughly 3% per Poké Ball.
- **A streak indicator on the wild tab.** Seven dots under the encounter bar, one per day of
  the rolling window, with the day that pays marked and the row greyed once it has fired.

### Changed

- **The companion renders at its true size** — roughly twice what it was. It had been drawn as
  a 48×48 still beside an 80px trainer, with the creature itself occupying 17 to 40 of those
  pixels. It now uses the animated sheet the wild Pokémon has always used, which is cropped to
  the feet, so the trainer, the companion and any wild Pokémon stand on one floor at every
  species. (The still sheet centres its art over a transparent floor whose depth varies by
  species — 8px under Charizard, 33px under Bulbasaur — which is why simply enlarging it made
  companions sink through the ground line.)
- **The shop says less and shows more**: thirteen cards down to ten, and 1,243px down to 980px
  at sidebar width. Each ball is one card carrying both its single and its ten-pack, so the
  three rows whose whole description was "10 at once, 10% off" are gone, and the ten-pack's
  saving rides a badge on its own button. The catch multiplier is a figure now — 1×, 1.5×, 2×
  — because three numbers in a column compare at a glance where three sentences do not. The
  three eggs shared a sentence describing their cost rather than their difference, so it moved
  to the group heading and each card kept only what it guarantees.

### Fixed

- **Several VS Code windows no longer fight over your save.** Every window runs its own
  extension host, scan worker and companion store, and all of them write the same files — a
  path keyed on the OS user, so the contenders include every profile and every fork, not just
  two windows of one editor. The save was read once per worker and written unconditionally on
  every tick, which made "last writer wins" the steady state rather than a rare race: an
  afternoon's catches, purchases and growth could be overwritten by a window that had been
  sitting idle. Both writers also used the same temporary filename, which could tear the file
  outright — and the recovery path then wrote a fresh state over what was left. Every change
  is now a read-modify-write under a short lock, so windows see each other's work instead of
  trampling it, and a purchase that could not be committed says so instead of appearing to
  have worked.
- **Only one window pays for the scan.** A cold pass over a real corpus takes about thirty
  seconds, and every open window was doing it independently. One window now scans and
  publishes; the others read the publication. Where nothing has been published yet, a window
  simply scans, exactly as before.
- **A catch in one window reaches the others in about a second**, rather than waiting up to a
  full refresh interval.
- The shop's wide layout put every heading into the product grid, so "ITEMS" could sit beside
  a ball and rows appeared under headings they did not belong to.
- The ball multipliers shown in the shop were typed by hand and could drift from the ones the
  purchase actually charges; they are derived from the same table now.

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
