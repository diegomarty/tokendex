/**
 * Platform data locations.
 *
 * The extension runs wherever the extension host runs — inside WSL for a Remote-WSL
 * window, on Windows for a local one — so every one of these must be resolved at runtime
 * rather than baked in.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

export const home = (): string => homedir()

/** Roaming application data: `~/Library/Application Support` | `%APPDATA%` | `$XDG_DATA_HOME`. */
export function appSupport(): string {
  if (process.platform === 'darwin') return join(home(), 'Library', 'Application Support')
  if (process.platform === 'win32') {
    return process.env['APPDATA'] ?? join(home(), 'AppData', 'Roaming')
  }
  return process.env['XDG_DATA_HOME'] ?? join(home(), '.local', 'share')
}

/** Machine-local application data: `%LOCALAPPDATA%` on Windows, same as appSupport elsewhere. */
export function localAppData(): string {
  if (process.platform === 'win32') {
    return process.env['LOCALAPPDATA'] ?? join(home(), 'AppData', 'Local')
  }
  return appSupport()
}

/**
 * Where editor-style apps keep configuration.
 *
 * Differs from `appSupport` on Linux only: VS Code and its forks (Cursor) use `~/.config`
 * there, while data-style stores use `~/.local/share`. On macOS and Windows the two coincide.
 */
export function configHome(): string {
  if (process.platform === 'darwin') return join(home(), 'Library', 'Application Support')
  if (process.platform === 'win32') {
    return process.env['APPDATA'] ?? join(home(), 'AppData', 'Roaming')
  }
  return process.env['XDG_CONFIG_HOME'] ?? join(home(), '.config')
}

/**
 * Where this app keeps its own state (game save, sprite cache, usage cache).
 *
 * `TOKENDEX_STATE_DIR` redirects all of it, which is what makes it safe to experiment: the
 * development scenarios mutate the real save, and an Extension Development Host pointed at a
 * throwaway directory cannot touch the progress you actually care about. Deliberately NOT
 * registered in `usageEnvironment`: that module is for *provider log locations* a user exports
 * for the CLI, while this is a dev/QA override the app itself defines.
 */
export function ourData(): string {
  const override = process.env['TOKENDEX_STATE_DIR']
  if (override !== undefined && override.trim() !== '') return override
  return join(appSupport(), 'Tokendex')
}
