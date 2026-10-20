/**
 * Folds a SQLite write-ahead log into the main database image.
 *
 * `sql.js` opens a byte array, and a byte array has no `-wal` beside it, so a store in WAL mode
 * reads as of its **last checkpoint** — everything committed since is silently missing. That is
 * not an edge case: a writer that keeps its connection open (the Copilot Chat extension, a
 * long CLI session) checkpoints only every ~1000 pages, so the main file can hold nothing but
 * the empty schema while the WAL holds every row. The native `sqlite3` upstream links reads the
 * WAL for free, which is why this exists only in the port.
 *
 * The format is the documented one (sqlite.org/fileformat2.html#walformat): a 32-byte header,
 * then frames of a 24-byte header plus one page. A frame counts only while its salts match the
 * header and the running checksum holds; only frames up to the **last commit frame** apply, so a
 * transaction the writer is still in the middle of is never half-read.
 */

const WAL_HEADER_BYTES = 32
const FRAME_HEADER_BYTES = 24
const MAGIC_LITTLE_ENDIAN = 0x377f0682
const MAGIC_BIG_ENDIAN = 0x377f0683

/** The database header's read/write format versions: 1 is rollback journal, 2 is WAL. */
const WRITE_VERSION_OFFSET = 18
const READ_VERSION_OFFSET = 19

/**
 * SQLite's WAL checksum: pairs of 32-bit words, in the byte order the magic number names,
 * accumulated into `seed`. Every addition wraps at 2^32.
 */
function checksum(
  data: Uint8Array,
  start: number,
  end: number,
  bigEndian: boolean,
  seed: [number, number],
) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let [s0, s1] = seed
  for (let i = start; i < end; i += 8) {
    s0 = (s0 + view.getUint32(i, !bigEndian) + s1) >>> 0
    s1 = (s1 + view.getUint32(i + 4, !bigEndian) + s0) >>> 0
  }
  return [s0, s1] as [number, number]
}

/**
 * Returns the database as a reader would see it with the WAL applied, or `main` unchanged when
 * the WAL is empty, foreign, or holds no complete transaction.
 */
export function applyWriteAheadLog(main: Uint8Array, wal: Uint8Array): Uint8Array {
  if (wal.byteLength < WAL_HEADER_BYTES) return main
  const view = new DataView(wal.buffer, wal.byteOffset, wal.byteLength)
  const magic = view.getUint32(0)
  if (magic !== MAGIC_LITTLE_ENDIAN && magic !== MAGIC_BIG_ENDIAN) return main
  const bigEndian = magic === MAGIC_BIG_ENDIAN

  const rawPageSize = view.getUint32(8)
  const pageSize = rawPageSize === 1 ? 65_536 : rawPageSize
  if (pageSize < 512 || pageSize > 65_536 || (pageSize & (pageSize - 1)) !== 0) return main

  let sum = checksum(wal, 0, 24, bigEndian, [0, 0])
  if (sum[0] !== view.getUint32(24) || sum[1] !== view.getUint32(28)) return main
  const salt1 = view.getUint32(16)
  const salt2 = view.getUint32(20)

  // Page number → offset of its latest committed image in the WAL.
  const committed = new Map<number, number>()
  const pending = new Map<number, number>()
  let databasePages = 0
  const frameBytes = FRAME_HEADER_BYTES + pageSize

  for (let at = WAL_HEADER_BYTES; at + frameBytes <= wal.byteLength; at += frameBytes) {
    // A salt mismatch is a frame left over from before the log was restarted: the end.
    if (view.getUint32(at + 8) !== salt1 || view.getUint32(at + 12) !== salt2) break
    sum = checksum(wal, at, at + 8, bigEndian, sum)
    sum = checksum(wal, at + FRAME_HEADER_BYTES, at + frameBytes, bigEndian, sum)
    // A torn or half-written frame: nothing after it can be trusted.
    if (sum[0] !== view.getUint32(at + 16) || sum[1] !== view.getUint32(at + 20)) break

    const page = view.getUint32(at)
    if (page === 0) break
    pending.set(page, at + FRAME_HEADER_BYTES)
    const commitSize = view.getUint32(at + 4)
    if (commitSize > 0) {
      for (const [p, offset] of pending) committed.set(p, offset)
      pending.clear()
      databasePages = commitSize
    }
  }

  if (databasePages === 0) return main

  const out = new Uint8Array(databasePages * pageSize)
  out.set(main.subarray(0, Math.min(main.byteLength, out.byteLength)))
  for (const [page, offset] of committed) {
    if (page > databasePages) continue // truncated away by a later commit
    out.set(wal.subarray(offset, offset + pageSize), (page - 1) * pageSize)
  }
  // Mark the image as a rollback-journal database, so the reader does not look for a WAL that
  // an in-memory image cannot have.
  out[WRITE_VERSION_OFFSET] = 1
  out[READ_VERSION_OFFSET] = 1
  return out
}
