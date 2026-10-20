import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { promises as fsp } from 'node:fs'
import initSqlJs from 'sql.js'
import { queryScalar, withDatabase } from '../src/core/usage/sqlite.js'
import { writeUncheckpointedDatabase } from './walFixture.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ptb-wal-test-'))
}

const count = (path: string) => withDatabase(path, (db) => queryScalar(db, 'SELECT COUNT(*) FROM t'))

/** Offset of the last frame's header, from the page size the WAL header declares. */
function lastFrameOffset(wal: Buffer): number {
  const pageSize = wal.readUInt32BE(8)
  const frameBytes = 24 + pageSize
  const frames = Math.floor((wal.byteLength - 32) / frameBytes)
  return 32 + (frames - 1) * frameBytes
}

function seed(): string {
  const path = join(tempDir(), 'store.db')
  writeUncheckpointedDatabase(path, [
    'CREATE TABLE t (n INTEGER)',
    'INSERT INTO t VALUES (1)',
    'INSERT INTO t VALUES (2)',
  ])
  return path
}

describe('write-ahead log', () => {
  // sql.js keeps the first runtime it builds. Built here, it resolves its wasm from the package;
  // left to `sqlite.ts`, it would look beside the source, where only the bundle puts one.
  beforeAll(async () => {
    await initSqlJs()
  })

  // [trigger branch] A writer that stays connected checkpoints rarely, so the main file can hold
  // only the empty schema. Reading it alone, the table does not even exist.
  it('reads rows that live only in the WAL', async () => {
    const path = seed()
    expect(await count(path)).toBe(2)
  })

  // The checksum chain is what tells a frame the writer finished from one it was still writing.
  // The page data is left intact, so only the checksum can reject it.
  it('drops a transaction whose frame fails its checksum', async () => {
    const path = seed()
    const wal = readFileSync(`${path}-wal`)
    const at = lastFrameOffset(wal)
    wal.writeUInt32BE((wal.readUInt32BE(at + 16) + 1) >>> 0, at + 16)
    writeFileSync(`${path}-wal`, wal)
    expect(await count(path)).toBe(1)
  })

  // A restarted log keeps old frames past its new end. They carry the previous salt, and the
  // checksum does not cover the salt — so only the salt comparison can stop them.
  it('stops at a frame from before the log was restarted', async () => {
    const path = seed()
    const wal = readFileSync(`${path}-wal`)
    const at = lastFrameOffset(wal)
    wal.writeUInt32BE((wal.readUInt32BE(at + 8) + 1) >>> 0, at + 8)
    writeFileSync(`${path}-wal`, wal)
    expect(await count(path)).toBe(1)
  })

  it('ignores a WAL that is not one', async () => {
    const path = seed()
    writeFileSync(`${path}-wal`, Buffer.alloc(64, 7))
    // Without the log the table was never checkpointed: the read succeeds, the table is absent.
    expect(await count(path)).toBeUndefined()
  })
})

describe('the size ceiling', () => {
  beforeAll(async () => {
    await initSqlJs()
  })

  // [trigger branch] The ceiling exists so a huge store costs nothing. Checking it *after* reading
  // the file pays the whole read on every refresh and throws it away.
  it('skips an oversized database without reading it', async () => {
    const path = seed()
    const reads = vi.spyOn(fsp, 'readFile')
    try {
      expect(await withDatabase(path, () => 1, 1_024)).toBeUndefined()
      expect(reads).not.toHaveBeenCalled()
    } finally {
      reads.mockRestore()
    }
  })

  it('counts the WAL toward the ceiling', async () => {
    const path = seed()
    const { size } = await fsp.stat(path)
    expect(await withDatabase(path, () => 1, size + 1)).toBeUndefined()
  })
})
