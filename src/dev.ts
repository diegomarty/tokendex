/**
 * The quick-pick front end for the development scenarios.
 *
 * The scenarios themselves live in `core/dev/scenarios.ts`, which also drives the panel's **Dev
 * tab** — that table is the single source, so a scenario can never exist in one surface and not
 * the other. This file only knows how to *ask*: an input box for an amount, a quick pick for a
 * choice, a modal for anything destructive.
 *
 * Gated behind `tokendex.devMode`, so it cannot be reached by accident in normal use.
 */

import * as vscode from 'vscode'
import { type DevScenario, DEV_GROUPS, DEV_SCENARIOS } from './core/dev/scenarios.js'
import { parseAmount } from './core/dev/simulation.js'
import type { WorkerAction } from './worker/scanWorker.js'

interface ScenarioItem extends vscode.QuickPickItem {
  scenario?: DevScenario
}

/** Asks for whatever the scenario needs. `undefined` = the user backed out. */
async function askFor(scenario: DevScenario): Promise<string | undefined> {
  const input = scenario.input
  if (input.kind === 'none') return ''

  if (input.kind === 'amount') {
    return vscode.window.showInputBox({
      prompt: input.prompt,
      value: input.defaultValue,
      validateInput: (raw) =>
        Number.isFinite(parseAmount(raw)) ? undefined : 'Use a number, or K/M/B suffixes',
    })
  }

  const picked = await vscode.window.showQuickPick(
    input.options.map((option) => ({ label: option.label, value: option.value })),
    { placeHolder: input.prompt },
  )
  return picked?.value
}

/**
 * Opens the picker and returns the actions to dispatch, in order.
 *
 * A scenario with `steps` yields that many copies: the caller dispatches them one by one so a
 * multi-step run reads as progress rather than collapsing into a single jump.
 */
export async function pickScenario(): Promise<WorkerAction[]> {
  const items: ScenarioItem[] = []
  for (const group of DEV_GROUPS) {
    const scenarios = DEV_SCENARIOS.filter((scenario) => scenario.group === group.id)
    if (scenarios.length === 0) continue
    items.push({ label: group.title, kind: vscode.QuickPickItemKind.Separator })
    for (const scenario of scenarios) {
      items.push({ label: scenario.label, detail: scenario.detail, scenario })
    }
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Tokendex · development simulation',
    matchOnDetail: true,
  })
  const scenario = picked?.scenario
  if (scenario === undefined) return []

  if (scenario.confirm !== undefined) {
    const confirmed = await vscode.window.showWarningMessage(
      scenario.label,
      { modal: true, detail: scenario.confirm },
      'Run',
    )
    if (confirmed !== 'Run') return []
  }

  const value = await askFor(scenario)
  if (value === undefined) return []
  const action = scenario.build(value)
  if (action === undefined) return []
  return Array.from({ length: scenario.steps ?? 1 }, () => action)
}
