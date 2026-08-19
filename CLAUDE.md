# Tokendex — project instructions

A VS Code extension that reads local AI-CLI usage logs and turns them into a companion that
grows in the status bar.

## Origin and upstream

Derived from [chattymin/PokeTokenBar](https://github.com/chattymin/PokeTokenBar) (MIT), a
macOS menu-bar app. The parsing engine and companion progression were ported to TypeScript.
`LICENSE` carries dual attribution; keep it.

**This repo does not contain the Swift source.** To see what upstream changed:

```
git clone https://github.com/chattymin/PokeTokenBar /tmp/ptb-upstream
git -C /tmp/ptb-upstream log --oneline <SHA in PORTED-THROUGH>..HEAD -- Sources/PokeTokenBar/Core/
```

Port what applies, then update `PORTED-THROUGH`. Upstream moves fast — it added three usage
providers in its first two months — so this is the route by which new providers arrive, not a
side task.

## Architecture rules

- **`src/core/` never imports `vscode`.** It stays unit-testable without launching the editor.
  `test/usage-environment.test.ts` enforces a related invariant mechanically.
- **The scan runs in a `worker_thread`, never on the extension host.** A cold scan of a real
  corpus takes ~30 s; blocking that thread freezes the editor.
- **The core emits text already formatted and localised.** The status bar and the webview
  never re-derive or re-format a number — a second formatting path is a second source of
  truth that drifts.
- **Provider location env vars go through `usageEnvironment`**, never `process.env` directly.

## Testing

Port the test before the implementation, then **inject the defect and confirm the test
fails**. A test that has never failed proves nothing. This caught two real gaps during the
port: a `new Date()` that diverged from Swift in three cases, and a missing guard on the
Codex subagent exemption.

`src/core/i18n/strings.ts` is **generated**. Brand mentions were rebranded after extraction;
re-running the extractor reintroduces the old name.

## Conventions

- Commits and PRs in English.
- **No `Co-Authored-By: Claude` trailer.**
- Sprites are fetched from PokéAPI at runtime and never bundled — a licence obligation. Keep
  the Pokémon disclaimer in the README.
