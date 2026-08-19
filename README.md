# Tokendex

Turns your local AI-CLI token usage into a Pokémon-style companion that grows in the status
bar. Ten AI CLIs are read directly from their own local logs — nothing is uploaded.

## What it does

- **Status bar** — today's tokens and your companion's mood, refreshed every 2 minutes.
- **Panel** — usage breakdown, your Pokémon's progress, shop, bag and Pokédex.
- **Grows from real work** — an egg hatches after ~5M tokens, then evolves and eventually
  graduates into the Pokédex.

## How it reads your usage

Local log files only:

| Provider    | Location                                                         |
| ----------- | ---------------------------------------------------------------- |
| Claude Code | `~/.claude/projects` (plus `CLAUDE_CONFIG_DIR`, comma-separated) |
| Codex       | `~/.codex/sessions`                                              |
| Gemini      | `~/.gemini/tmp`                                                  |
| Grok        | `~/.grok/sessions` (plus `GROK_HOME`)                            |
| Antigravity | `~/.gemini/antigravity-cli/conversations`                        |
| Cursor      | the editor's `state.vscdb`                                       |
| Copilot     | the CLI's history store (plus `COPILOT_HOME`)                    |
| OpenCode    | `~/.local/share/opencode` (plus `OPENCODE_DATA_DIR`)             |
| Hermes      | the CLI's home (plus `HERMES_HOME`)                              |
| Kiro        | the CLI's data directory                                         |

Providers you do not use never appear — a permanent row of zeros is noise.

Nothing is sent anywhere. The one network call is to [PokéAPI](https://pokeapi.co) for
sprites and species data, fetched at runtime.

### Working in WSL

Install the extension inside your WSL window. It declares `"extensionKind": ["workspace"]`, so
the extension host runs where your logs are and reads them at native speed. Reading a WSL home
from Windows across the `\\wsl$` bridge was measured at ~17x slower.

## Performance

Measured on a real 1.4 GB corpus (970 MB Claude, 494 MB Codex):

|                           |             |
| ------------------------- | ----------- |
| First scan ever           | ~30 s, once |
| Startup with a warm cache | ~100 ms     |
| Each refresh              | 65-80 ms    |

Scanning runs in a `worker_thread`, never on the extension host, so VS Code is never blocked.

## Settings

| Setting                    | Default       |
| -------------------------- | ------------- |
| `tokendex.refreshInterval` | `120` seconds |

## Credits

Pokémon and Pokémon character names are trademarks of Nintendo. This project is a fan work,
is not affiliated with or endorsed by Nintendo, Creatures Inc. or GAME FREAK Inc., and bundles
no Pokémon assets — sprites are fetched from PokéAPI at runtime.

## Licence

MIT — see [`LICENSE`](LICENSE).
