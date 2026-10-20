import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { promises as fsp } from 'node:fs'
import { DEVICE_FILE_NAME, deviceIdentity } from '../src/core/companion/device.js'

const tempDir = () => mkdtempSync(join(tmpdir(), 'ptb-device-'))

describe('device identity', () => {
  it('is minted once and then read back', async () => {
    const dir = tempDir()
    const first = await deviceIdentity(dir)
    expect(first.id).toMatch(/^[0-9a-f]{32}$/)
    expect(await deviceIdentity(dir)).toEqual(first)
  })

  // [trigger branch] Two windows starting together. Without the exclusive create each mints its
  // own id, and the loser's first accruals are counted under an id the save then forgets.
  it('converges when two windows mint at once', async () => {
    const dir = tempDir()
    const ids = new Set(
      (await Promise.all(Array.from({ length: 8 }, () => deviceIdentity(dir)))).map((d) => d.id),
    )
    expect(ids.size).toBe(1)
    expect(JSON.parse(readFileSync(join(dir, DEVICE_FILE_NAME), 'utf8')).id).toBe([...ids][0])
  })

  // The label names an exported save's source. A hostname often carries a real name.
  it('never uses the hostname as the label', async () => {
    const { label } = await deviceIdentity(tempDir())
    expect(label).toMatch(/^device-[0-9a-f]{6}$/)
  })

  it('replaces an unreadable identity file', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, DEVICE_FILE_NAME), 'not json')
    const identity = await deviceIdentity(dir)
    expect(identity.id).toMatch(/^[0-9a-f]{32}$/)
    expect(await deviceIdentity(dir)).toEqual(identity)
  })
})

describe('device identity under a slow disk', () => {
  // [trigger branch] An exclusive create is not an atomic publish: the file exists, empty, between
  // the create and the write. A second window reading in that gap saw garbage, deleted the first
  // window's file and minted its own id — one machine, two devices. This reproduces the gap.
  it('never lets a window read a half-written identity', async () => {
    const real = fsp.writeFile.bind(fsp)
    const slow = vi.spyOn(fsp, 'writeFile').mockImplementation(async (path, data, options) => {
      const flag =
        typeof options === 'object' && options !== null ? (options as { flag?: string }).flag : undefined
      if (flag === 'wx') {
        await real(path, '', { flag: 'wx' }) // the kernel creates it empty…
        await new Promise((resolve) => setTimeout(resolve, 30)) // …and the bytes land later
        return real(path, data as string)
      }
      return real(path, data as string, options as never)
    })
    try {
      const dir = tempDir()
      const ids = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          new Promise((resolve) => setTimeout(resolve, i * 5)).then(() => deviceIdentity(dir)),
        ),
      )
      expect(new Set(ids.map((d) => d.id)).size).toBe(1)
    } finally {
      slow.mockRestore()
    }
  })
})
