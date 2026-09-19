import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Absolute path to `src/`, for the guards that read the source text rather than import it.
 *
 * Resolved by walking up rather than trusting `process.cwd()`, and deliberately not via
 * `import.meta.url`: these files compile into CommonJS output, where `import.meta` is a
 * TS1470 error. `test/usage-environment.test.ts` established the walk after a guard pointed
 * at a directory that did not exist and silently inspected nothing.
 */
export function sourceRoot(): string {
  let dir = process.cwd()
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'src', 'core')
    if (existsSync(candidate)) return join(dir, 'src')
    const nested = join(dir, 'extension', 'src', 'core')
    if (existsSync(nested)) return join(dir, 'extension', 'src')
    dir = join(dir, '..')
  }
  throw new Error('src/ not found — a guard that quietly inspects nothing is worse than none')
}
