/**
 * SQLite access via `sql.js` (SQLite compiled to WebAssembly).
 *
 * **Do not swap this for `better-sqlite3`.** It is a native module, which would force one
 * platform-specific VSIX per target — the exact cost the TypeScript port exists to avoid.
 *
 * The trade-off `sql.js` imposes: it has no incremental file access, so opening a database
 * reads the **whole file into memory**. That is fine for the stores read here (a few MB), but
 * it is why `MAX_DATABASE_BYTES` exists — a Cursor `state.vscdb` can grow to hundreds of
 * megabytes, and loading that on a 2-minute refresh would be worse than not reporting Cursor
 * at all.
 */

import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Database, SqlJsStatic } from 'sql.js'

/**
 * Databases larger than this are skipped rather than loaded.
 *
 * Reporting one provider is not worth stalling every refresh: `sql.js` would read the entire
 * file, and the scan runs on a worker whose whole point is staying responsive.
 */
export const MAX_DATABASE_BYTES = 256 * 1024 * 1024

let runtime: Promise<SqlJsStatic> | undefined

/**
 * Loads the WebAssembly runtime once per worker.
 *
 * `locateFile` is explicit because esbuild bundles the JS but not the `.wasm`, which is copied
 * into `dist/` at build time. Without this, `sql.js` looks for it beside the *bundle* under a
 * name it cannot resolve, and every SQLite provider silently reports nothing.
 */
function sqlRuntime(): Promise<SqlJsStatic> {
  runtime ??= (async () => {
    // Required rather than imported: esbuild would otherwise try to bundle the emscripten
    // glue, and the bundle output is CommonJS anyway.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const initSqlJs = require('sql.js') as (config?: {
      locateFile?: (file: string) => string
    }) => Promise<SqlJsStatic>
    return initSqlJs({ locateFile: (file: string) => join(__dirname, file) })
  })()
  return runtime
}

/** One row, as a map from column name to value. */
export type Row = Record<string, unknown>

/**
 * Opens a database read-only, runs `work`, and always closes.
 *
 * Returns `undefined` when the database cannot be read at all — missing, too large, locked by
 * the writer, or corrupt. Callers must treat that as "unknown", **not** as "empty": collapsing
 * the two is what erases a watermark and replays a month of rows.
 */
export async function withDatabase<T>(path: string, work: (db: Database) => T): Promise<T | undefined> {
  let bytes: Buffer
  try {
    const stat = await fs.stat(path)
    if (!stat.isFile() || stat.size > MAX_DATABASE_BYTES) return undefined
    bytes = await fs.readFile(path)
  } catch {
    return undefined
  }

  let db: Database | undefined
  try {
    const SQL = await sqlRuntime()
    db = new SQL.Database(bytes)
    return work(db)
  } catch {
    return undefined
  } finally {
    try {
      db?.close()
    } catch {
      // Closing a database that failed to open is not an error worth surfacing.
    }
  }
}

/**
 * Runs one query and returns its rows.
 *
 * `undefined` means the query could not run — a missing table (an older schema generation), a
 * locked file, a corrupt page. It is deliberately distinct from `[]`, which means the query
 * ran and matched nothing.
 */
export function queryRows(db: Database, sql: string, params: unknown[] = []): Row[] | undefined {
  let statement
  try {
    statement = db.prepare(sql)
  } catch {
    return undefined // most often: this schema generation has no such table
  }
  try {
    if (params.length > 0) statement.bind(params as never)
    const rows: Row[] = []
    while (statement.step()) rows.push(statement.getAsObject() as Row)
    return rows
  } catch {
    return undefined
  } finally {
    statement.free()
  }
}

/** Convenience for a single scalar. `undefined` keeps the "could not read" meaning. */
export function queryScalar(db: Database, sql: string, params: unknown[] = []): number | undefined {
  const rows = queryRows(db, sql, params)
  if (rows === undefined || rows.length === 0) return undefined
  const value = Object.values(rows[0]!)[0]
  if (value === null || value === undefined) return 0 // MAX() over no rows is SQL NULL
  return typeof value === 'number' ? value : Number(value)
}

/** Full path resolution helper shared by the providers: a file path is used as-is. */
export function databaseAt(root: string, fileName: string, extensions: string[]): string {
  const lower = root.toLowerCase()
  return extensions.some((ext) => lower.endsWith(ext)) ? root : join(root, fileName)
}

export { dirname }
