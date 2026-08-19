# Contributing to Tokendex

Thanks for your interest! Tokendex is a small, non-commercial fan project, and contributions
of every size are welcome — bug reports, fixes, new usage providers, translations, and
documentation.

Please read the short sections below before opening a pull request. Most surprising-looking
code in this repository has a reason written down beside it — the comments carry the
measurements behind the architecture and the traps already hit, so read them before
simplifying something that looks redundant.

## Prerequisites

- **Node.js 20 or newer**
- **VS Code 1.85 or newer**

No platform-specific toolchain and no native modules: the extension runs wherever the VS Code
extension host runs — Windows, macOS, Linux, and inside WSL.

## Build & test

```bash
npm ci                  # install
npm run format:check    # Prettier, pinned in .prettierrc.json
npm run typecheck       # extension + webview (two tsconfigs)
npm test                # vitest
node esbuild.mjs        # build the four bundles into dist/
npm run package         # produce the .vsix
```

CI runs exactly that sequence on every pull request. Run it locally first — in particular
`format:check`, which fails the build rather than letting a reformat sneak into a diff.

To try your change, press <kbd>F5</kbd> to launch an Extension Development Host. Set
`TOKENDEX_STATE_DIR` to a throwaway directory first if you are touching game state: the
development scenarios behind the `tokendex.dev` command mutate the real save.

## Contribution workflow

1. Create a feature branch off `main` (fork the repo if you don't have write access).
2. Make your change with tests. Keep it focused.
3. Open a pull request against `main`.
4. Once CI passes and the change is reviewed, it is merged via **squash merge**.

### Language: English first

This repository uses **English as its first language** for collaboration artifacts. Pull
request titles and bodies, and commit messages, must be in English. Because the repository
squash-merges, the PR title becomes the commit subject on `main`, so English PRs are what
keep the public history readable.

### Commit & PR conventions — gitmoji

Commit subjects and PR titles use the **gitmoji** convention: an emoji, then one imperative
sentence. The emoji replaces the type prefix entirely — do **not** write `feat:`, `fix:`,
`docs:` or any other Conventional Commits prefix.

```
<emoji> <Imperative description>
```

- One emoji per commit. If two genuinely apply, that is a sign the commit should be split.
- Imperative mood, sentence case, no trailing period: `Add …`, not `Added …` or `Adds …`.
- Keep the subject under 72 characters.
- One line. Put the reasoning in the PR body, where reviewers will actually read it.

| Emoji | Intent                                          |
| ----- | ----------------------------------------------- |
| ✨    | New feature or new content                      |
| 🐛    | Bug fix                                         |
| ♻️    | Refactor — same behaviour, different code       |
| 🎨    | Improve UI, visual style or formatting          |
| 💄    | Cosmetic only (CSS, layout, no logic)           |
| 🔥    | Remove code or files                            |
| 📝    | Documentation                                   |
| 💡    | Comments in source code                         |
| 🔧    | Config or tooling (tsconfig, esbuild, Prettier) |
| 📦    | `package.json` / manifest                       |
| ➕ ➖ | Add / remove a dependency                       |
| ⬆️    | Upgrade a dependency                            |
| ✅    | Tests — **only** when the change is tests-only  |
| ⚡    | Performance                                     |
| 🌐    | Internationalisation                            |
| 👷    | CI                                              |
| 🚨    | Fix linter or formatter warnings                |
| 🏗️    | Architecture change                             |
| 🔖    | Version tag / release                           |

Examples from this repository:

```
✨ Add the Grok CLI provider and honour $GROK_HOME
🎨 Add a Prettier config and reflow the extension host files
♻️ Split the companion store into pure modules
🐛 Stop a copied conversation reading as fresh spend
```

**Group commits by coherent change, not by file or by layer.** A commit should read as one
idea; spanning several files and layers is normal when they only make sense together.

**Code and its tests belong in the same commit.** They are atomic and revertible together, so
`✅` is reserved for changes that genuinely add nothing but tests.

**UI changes** (anything under `src/webview/`) should describe the before/after in the PR.
Screenshots or GIFs are welcome but optional — a clear text description is fine.

## Code conventions

The extension is provider-agnostic by design. When extending it, follow these rules; several
of them are enforced mechanically by tests.

### Extension points

- **Adding a usage source** (a new AI CLI): one new module under `src/core/usage/`, one method
  on `LocalUsageCache` (`cache.ts`), and one entry in the worker's provider list
  (`src/worker/scanWorker.ts` — both the `read(…)` call and the `sources` array). Root
  discovery goes in `roots.ts`; a location environment variable goes in
  `USAGE_ENVIRONMENT_NAMES`. Those are the only places you should need to touch.
- **Adding a version manager or install path**: add it to
  `binaryLocator.commonToolDirectories()`, the single source shared by binary discovery and
  the child process `PATH`.
- **Adding an append-only SQLite store** (row-id high-water mark, like Cursor or Copilot):
  call `scanIncrementalStores` in `src/core/usage/additional.ts` with the format-specific
  path, `MAX` SQL, row query and parser. Do not copy the watermark loop — getting it wrong
  silently replays or drops a month of rows.
- **Generic behaviour must aggregate across all providers** — today/week/month totals, burn
  tier, companion rhythm. Never attach a generic calculation to a single provider, and never
  add a `providerID === '…'` literal branch on a generic path. Provider-specific behaviour
  (official limits, for instance) is the only thing that may branch on the provider.

### Invariants

These are load-bearing, and each one is explained where it is enforced:

- **`src/core/` never imports `vscode`.** It stays unit-testable without launching an editor.
- **The scan runs in a `worker_thread`, never on the extension host.** A cold scan of a real
  corpus takes ~30 seconds; blocking that thread freezes the editor.
- **The core emits text already formatted and localised.** If the UI re-derives a number,
  that is a second source of truth, and it drifts.
- **Provider location environment variables go through `usageEnvironment`**, never
  `process.env` directly. A GUI-launched process does not inherit the login shell, so reading
  the environment directly makes a user who exported `CLAUDE_CONFIG_DIR` in `~/.zshrc` see
  zero — correct in their CLI, broken in the extension, irreproducible in tests. Two tests
  enforce this.
- **SQLite goes through `sql.js`, not `better-sqlite3`.** A native module would mean one VSIX
  per platform, which is the whole cost this port exists to avoid.
- **Official limits never block a scan.** They are decoration; the totals are not.
- **Sprites are fetched from PokéAPI at runtime and never bundled.** A licence obligation.

### Formatting

Prettier is pinned in `.prettierrc.json` and checked in CI. Run `npm run format` before
committing. Do not run Prettier with a different config or from a directory where it cannot
find this one — an unconfigured run once rewrote four files into Prettier's defaults and
buried a real change under a 700-line diff.

## Testing

Tests run under vitest. Two rules matter more than coverage:

**Write the test first, then inject the defect and confirm the test fails.** A test that has
never failed proves nothing. This caught two real gaps: a `new Date()` that read three
specific timestamps wrong, and a missing guard on the Codex subagent exemption.

**Reproduce the exact branch that triggers the bug.** For an `A || B` gate, test **B alone**
(A false, B true) — a test that passes through a different path gives false confidence, which
is how most of the regressions in this codebase happened in the first place.

When you fix a defect, do not stop at the fix: sweep the codebase for the same _class_ of
mistake (the same API misuse, the same pattern), and leave the prevention behind as a test,
a guard, or a comment at the point it would recur — a mechanism, not a memory.

Note that `src/core/i18n/strings.ts` is **generated**. Edit `dispatch.ts` for anything new
rather than re-running the extractor.

## Legal / intellectual property

Tokendex is an **unofficial, non-commercial fan project**. It is not affiliated with, or
endorsed by, Nintendo, Game Freak, Creatures Inc., or The Pokémon Company. To keep the project
safe to maintain and distribute, contributions **must** follow these rules:

- **Do not commit or bundle any Pokémon (or other third-party) copyrighted assets** —
  sprites, artwork, audio, fonts, or bulk name/data files. Species data and sprites are
  fetched **at runtime** from the public [PokéAPI](https://pokeapi.co) and cached on the
  user's own device. Keep it that way.
- **Do not add features intended for commercial use**, or features that redistribute or
  export copyrighted assets.
- **Do not commit secrets, credentials, or references to private or internal tooling.**
  Everything in the repository must be generic and public-safe.
- By submitting a contribution you confirm it is your **own original work**, and you agree it
  is licensed under this project's [MIT License](LICENSE). That licence covers this project's
  source code only — it grants no rights to third-party trademarks, artwork, or data.

## Reporting bugs & requesting features

Open an issue. For bugs, please include:

- your OS, and whether you are running VS Code locally or through Remote-WSL / Remote-SSH,
- the VS Code and Tokendex versions,
- which AI CLI(s) you use,
- steps to reproduce, and anything the panel showed in its error list.

If you are a rights holder with a concern about this project, please open an issue or contact
the maintainer, and we will respond promptly.
