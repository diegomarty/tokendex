# Tokendex

Turns your local AI-CLI token usage into a Pokémon-style companion that grows in the status
bar. Claude Code and Codex are read directly from their local logs — nothing is uploaded.

## What it does

- **Status bar** — today's tokens and your companion's mood, refreshed every 2 minutes.
- **Panel** — usage breakdown, your Pokémon's progress, shop, bag and Pokédex.
- **Grows from real work** — an egg hatches after ~5M tokens, then evolves and eventually
  graduates into the Pokédex.

## How it reads your usage

Local log files only:

| Provider | Location |
|---|---|
| Claude Code | `~/.claude/projects` (plus `CLAUDE_CONFIG_DIR`, comma-separated) |
| Codex | `~/.codex/sessions` |

Nothing is sent anywhere. The one network call is to [PokéAPI](https://pokeapi.co) for
sprites and species data, fetched at runtime.

### Working in WSL

Install the extension inside your WSL window. It declares `"extensionKind": ["workspace"]`, so
the extension host runs where your logs are and reads them at native speed. Reading a WSL home
from Windows across the `\\wsl$` bridge was measured at ~17x slower.

## Performance

Measured on a real 1.4 GB corpus (970 MB Claude, 494 MB Codex):

| | |
|---|---|
| First scan ever | ~30 s, once |
| Startup with a warm cache | ~100 ms |
| Each refresh | 65-80 ms |

Scanning runs in a `worker_thread`, never on the extension host, so VS Code is never blocked.

## Settings

| Setting | Default |
|---|---|
| `tokendex.refreshInterval` | `120` seconds |

## Credits

Derived from [chattymin/PokeTokenBar](https://github.com/chattymin/PokeTokenBar) (MIT), a
macOS menu-bar app. The usage-parsing engine and the companion progression were ported to
TypeScript and rebuilt as a cross-platform VS Code extension: the scan runs in a worker
thread, the cache and the game rules were restructured into pure modules, and the UI is a
webview rather than AppKit.

Pokémon and Pokémon character names are trademarks of Nintendo. This project is a fan work,
is not affiliated with or endorsed by Nintendo, Creatures Inc. or GAME FREAK Inc., and bundles
no Pokémon assets — sprites are fetched from PokéAPI at runtime.

## Licence

MIT, with dual attribution: see `LICENSE`. Copyright is held by Diego Martín for this
extension and by chattymin for the original work it derives from.
