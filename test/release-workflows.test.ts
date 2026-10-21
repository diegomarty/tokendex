import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// 0.5.0 and 1.0.0 were tagged by `bump.yml` and never released: the tag push did not start
// `release.yml` (a push GitHub attributes to the workflow's own token starts no run), and the
// release, when cut by hand, had GitHub's generated notes instead of the changelog's. These pin
// the fix where it lives: the release is dispatched explicitly, and its notes are the
// changelog's section for the version.

const root = join(__dirname, '..')
const script = join(root, '.github', 'scripts', 'changelog.sh')
const workflow = (name: string) => readFileSync(join(root, '.github', 'workflows', name), 'utf8')

const CHANGELOG = `# Changelog

## [Unreleased]

## [1.0.0] - 2026-10-21

### Added

- One thing.

### Fixed

- Another.

## [0.5.0] - 2026-10-20

- Older.
`

function notes(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ptb-changelog-'))
  const file = join(dir, 'CHANGELOG.md')
  writeFileSync(file, CHANGELOG, 'utf8')
  return execFileSync('bash', [script, 'notes', version], {
    env: { ...process.env, CHANGELOG_FILE: file },
    encoding: 'utf8',
  })
}

describe('the release notes', () => {
  it('are the changelog section of that version, and nothing of the next', () => {
    expect(notes('1.0.0')).toBe('### Added\n\n- One thing.\n\n### Fixed\n\n- Another.\n')
    expect(notes('0.5.0')).toBe('- Older.\n')
  })

  // [trigger branch] A version with no section must fail the release, not publish empty notes.
  it('refuse a version the changelog does not hold', () => {
    expect(() => notes('9.9.9')).toThrow()
  })
})

describe('cutting a release', () => {
  it('dispatches release.yml on the tag instead of relying on the tag push', () => {
    const bump = workflow('bump.yml')
    expect(bump).toMatch(/gh workflow run release\.yml --ref "v\$NEXT"/)
    expect(bump).toMatch(/actions: write/)
    // No second token to keep alive: the workflow's own pushes the tag and dispatches the run.
    expect(bump).not.toMatch(/secrets\.RELEASE_TOKEN/)
  })

  it('can be dispatched, and publishes the changelog’s notes', () => {
    const release = workflow('release.yml')
    expect(release).toMatch(/workflow_dispatch:/)
    expect(release).toMatch(/changelog\.sh notes/)
    expect(release).toMatch(/body_path: release-notes\.md/)
    expect(release).not.toMatch(/generate_release_notes: true/)
  })
})
