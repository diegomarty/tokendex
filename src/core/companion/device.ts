/**
 * This machine's identity, as far as merging saves is concerned.
 *
 * Kept in its own file beside the save rather than inside it, because it is the one thing that
 * must **never** travel: an imported or merged save carries the other machine's counters, and
 * an id stored in the save would arrive with them and make two machines one. A file nobody
 * exports cannot leak that way, and every VS Code window and profile on the machine shares it,
 * because they share `ourData()` — so they are one device, which is what they are.
 *
 * Never the hostname. Hostnames routinely carry a person's real name, and this label is what
 * an exported save names its source with (`docs/sync.md` §5).
 */

import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { atomicCreateFile, atomicWriteFile } from '../coordination/atomicWrite.js'

export interface DeviceIdentity {
  /** Random, minted once. The key of `usedByDevice` and `revision`. */
  id: string
  /** What a save says it came from. Neutral by default; meant to be renamed by the user. */
  label: string
}

export const DEVICE_FILE_NAME = 'device.json'

function parseIdentity(text: string): DeviceIdentity | undefined {
  try {
    const raw: unknown = JSON.parse(text)
    if (typeof raw !== 'object' || raw === null) return undefined
    const { id, label } = raw as Record<string, unknown>
    if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) return undefined
    return { id, label: typeof label === 'string' && label.trim() !== '' ? label : defaultLabel(id) }
  } catch {
    return undefined
  }
}

function defaultLabel(id: string): string {
  return `device-${id.slice(0, 6)}`
}

/**
 * Reads this machine's identity from `directory`, minting it on first use.
 *
 * Published atomically: the identity is written to a private temporary file and then **linked**
 * into place. A link either creates the name with the complete contents or fails because the
 * name exists — there is no moment where `device.json` exists but is empty. An exclusive create
 * was not enough: it creates the file first and writes it after, and a second window starting
 * in that gap read an empty file, took it for corruption, replaced it and counted its usage under
 * an id the machine then forgot. The loser of the link race reads the winner's instead.
 *
 * A file that is genuinely unreadable (only possible by hand now) is replaced by rename, which is
 * atomic too, and whatever is then on disk is what every window uses.
 */
export async function deviceIdentity(directory: string): Promise<DeviceIdentity> {
  const path = join(directory, DEVICE_FILE_NAME)
  const read = async () => {
    try {
      return parseIdentity(await fs.readFile(path, 'utf8'))
    } catch {
      return undefined
    }
  }

  const existing = await read()
  if (existing !== undefined) return existing

  const id = randomBytes(16).toString('hex')
  const minted: DeviceIdentity = { id, label: defaultLabel(id) }
  const text = JSON.stringify(minted, null, 2)
  try {
    if (await atomicCreateFile(path, text)) return minted
    // Someone published first, or the file is there but unreadable.
    const winner = await read()
    if (winner !== undefined) return winner
    await atomicWriteFile(path, text, 'utf8')
    return (await read()) ?? minted
  } catch {
    // The directory is unwritable: an in-memory id keeps this session counting correctly.
    return minted
  }
}
