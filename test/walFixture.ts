import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * `node:sqlite` is untyped under the pinned `@types/node`, and `sql.js` cannot produce a WAL at
 * all — it is an in-memory engine. Only the two calls the fixture needs are declared.
 */
interface NativeDatabase {
  exec(sql: string): void
  close(): void
}

function openNative(path: string): NativeDatabase {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string) => NativeDatabase
  }
  return new DatabaseSync(path)
}

/**
 * Writes `path` and `path-wal` exactly as a store looks while its writer is still connected:
 * every statement committed, none of it checkpointed into the main file.
 *
 * The copy is taken **before** closing, because closing the last connection checkpoints the log
 * and deletes it — which is precisely the state a reader never sees in the field.
 */
export function writeUncheckpointedDatabase(path: string, statements: string[]): void {
  const work = join(mkdtempSync(join(tmpdir(), 'ptb-wal-')), 'store.db')
  const db = openNative(work)
  try {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA wal_autocheckpoint = 0')
    // One transaction per statement, so a test can tell the last commit from the ones before.
    for (const sql of statements) db.exec(sql)
    mkdirSync(dirname(path), { recursive: true })
    copyFileSync(work, path)
    copyFileSync(`${work}-wal`, `${path}-wal`)
  } finally {
    db.close()
  }
}
