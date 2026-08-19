/**
 * Platform data locations, replacing the direct
 * `FileManager.default.urls(for: .applicationSupportDirectory, ...)` calls and the four
 * hard-coded `Library/Application Support` literals in the Swift original.
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

/** Where this app keeps its own state (game save, sprite cache, usage cache). */
export function ourData(): string {
  return join(appSupport(), 'Tokendex')
}


