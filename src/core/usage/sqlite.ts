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
 *
 * A byte array also has no `-wal` beside it, so `wal.ts` folds the log in before opening —
 * without that, a store in WAL mode reads as of its last checkpoint.
 */

import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Database, SqlJsStatic } from 'sql.js'
import { applyWriteAheadLog } from './wal.js'

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

/** Attempts at a consistent main-file + WAL pair before giving up as "unknown". */
const SNAPSHOT_ATTEMPTS = 3

async function readOptional(path: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(path)
  } catch {
    return undefined
  }
}

/**
 * The database as a reader would see it: the main file with its `-wal` folded in.
 *
 * Two files cannot be read atomically, so the WAL is read on both sides of the main file and
 * the pair is used only when the WAL did not move in between. A checkpoint copies frames the
 * first read already holds, so re-applying them is harmless; what is not harmless is a log
 * that grew or restarted mid-read, pairing pages from two different moments.
 */
async function readDatabaseImage(path: string, limit: number): Promise<Uint8Array | undefined> {
  // Sized from `stat` *before* anything is read: the ceiling exists so a huge store costs
  // nothing, and checking it after the read would pay for the whole file on every refresh.
  try {
    const stat = await fs.stat(path)
    if (!stat.isFile()) return undefined
    const wal = await fs.stat(`${path}-wal`).catch(() => undefined)
    if (stat.size + (wal?.size ?? 0) > limit) return undefined
  } catch {
    return undefined
  }

  for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt++) {
    const walBefore = await readOptional(`${path}-wal`)
    const main = await readOptional(path)
    if (main === undefined) return undefined
    // Re-checked on what was actually read: the files can grow between the stat and the read.
    if (main.byteLength + (walBefore?.byteLength ?? 0) > limit) return undefined
    if (walBefore === undefined || walBefore.byteLength === 0) return main

    const walAfter = await readOptional(`${path}-wal`)
    if (walAfter !== undefined && walAfter.equals(walBefore)) return applyWriteAheadLog(main, walBefore)
  }
  // Still moving after every attempt. Unknown, not empty: a watermark must not advance on it.
  return undefined
}

/** One row, as a map from column name to value. */
export type Row = Record<string, unknown>

/**
 * Opens a database read-only, runs `work`, and always closes.
 *
 * Returns `undefined` when the database cannot be read at all — missing, too large, locked by
 * the writer, still being written through every snapshot attempt, or corrupt. Callers must treat that as "unknown", **not** as "empty": collapsing
 * the two is what erases a watermark and replays a month of rows.
 */
export async function withDatabase<T>(
  path: string,
  work: (db: Database) => T,
  limit: number = MAX_DATABASE_BYTES,
): Promise<T | undefined> {
  const bytes = await readDatabaseImage(path, limit)
  if (bytes === undefined) return undefined

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
