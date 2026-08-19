/**
 * Development simulation menu.
 *
 * Gated behind `tokendex.devMode`, so it cannot be reached by accident in normal use.
 *
 * The design rule: prefer **spending synthetic tokens** over poking the save. An offset runs
 * the whole production pipeline (ledger, crediting, growth, evolution, graduation), so it
 * exercises the real rules; writing into the state directly would look identical on screen
 * while testing nothing. Direct pokes are reserved for states you cannot practically reach by
 * spending — a shiny is 1-in-64, a Ditto 1-in-128.
 *
 * **Adding a scenario is one entry in `SCENARIOS`.**
 */

import * as vscode from 'vscode'
import type { WorkerAction } from './worker/scanWorker.js'
import { parseAmount } from './core/dev/simulation.js'

/** Resolved lazily so a scenario can prompt for input before producing its action. */
export type ScenarioResult = WorkerAction | WorkerAction[] | undefined

export interface Scenario {
  label: string
  detail: string
  /** Grouping in the picker. */
  group: 'tokens' | 'state' | 'items' | 'edge' | 'reset'
  run: () => Promise<ScenarioResult> | ScenarioResult
}

const M = 1_000_000
const B = 1_000_000_000

async function askAmount(prompt: string, value: string): Promise<number | undefined> {
  const raw = await vscode.window.showInputBox({
    prompt,
    value,
    validateInput: (v) => (Number.isFinite(parseAmount(v)) ? undefined : 'Usa un número, o sufijos K/M/B'),
  })
  if (raw === undefined) return undefined
  return parseAmount(raw)
}

async function pickItem(): Promise<'rareCandy' | 'mint' | 'shinyCharm' | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: '🍬 Caramelo Raro', id: 'rareCandy' as const },
      { label: '🌿 Menta', id: 'mint' as const },
      { label: '✨ Amuleto Iris', id: 'shinyCharm' as const },
    ],
    { placeHolder: '¿Qué objeto?' },
  )
  return picked?.id
}

/**
 * The scenario table. One entry per thing you might want to see happen.
 */
export const SCENARIOS: Scenario[] = [
  // ---- spending synthetic tokens: these run the real pipeline ----
  {
    group: 'tokens',
    label: '$(add) Sumar tokens…',
    detail: 'Inyecta tokens ficticios en la observación (acepta 250M, 1.5B)',
    run: async () => {
      const amount = await askAmount('Tokens a sumar', '50M')
      return amount === undefined ? undefined : { action: 'devAddTokens', provider: 'claude_code', amount }
    },
  },
  {
    group: 'tokens',
    label: '$(rocket) Justo hasta el siguiente hito',
    detail: 'Eclosión, evolución o graduación — lo que toque ahora. Calculado, no fijo.',
    run: () => ({ action: 'devAddToMilestone', scope: 'next' }),
  },
  {
    group: 'tokens',
    label: '$(mortar-board) Hasta graduarse',
    detail: 'Suma lo necesario para recorrer toda la línea y entrar en la Pokédex',
    run: () => ({ action: 'devAddToMilestone', scope: 'graduation' }),
  },
  {
    group: 'tokens',
    label: '$(watch) Simular un rato de trabajo (5 pasos)',
    detail: 'Cinco incrementos seguidos, para ver la barra avanzar como en uso real',
    run: () =>
      Array.from({ length: 5 }, () => ({
        action: 'devAddTokens' as const,
        provider: 'claude_code',
        amount: 20 * M,
      })),
  },
  {
    group: 'tokens',
    label: '$(discard) Quitar todos los tokens ficticios',
    detail: 'Vuelve a la observación real. El libro mayor lo trata como regresión y rebasa.',
    run: () => ({ action: 'devClearOffsets' }),
  },

  // ---- wallet and items ----
  {
    group: 'items',
    label: '$(credit-card) Añadir saldo gastable…',
    detail: 'Sube usedSinceInstall para poder comprar en la tienda',
    run: async () => {
      const amount = await askAmount('Saldo a añadir', '5B')
      return amount === undefined ? undefined : { action: 'devGrantTokens', amount }
    },
  },
  {
    group: 'items',
    label: '$(package) Dar objetos…',
    detail: 'Añade unidades a la bolsa sin pasar por la tienda',
    run: async () => {
      const item = await pickItem()
      if (item === undefined) return undefined
      const count = await askAmount('¿Cuántos?', '5')
      return count === undefined ? undefined : { action: 'devGrantItem', item, count }
    },
  },

  // ---- states that are impractical to reach by chance ----
  {
    group: 'state',
    label: '$(star-full) Hacer shiny al actual',
    detail: '1 entre 64 en producción; aquí, directo',
    run: () => ({ action: 'devSetShiny', value: true }),
  },
  {
    group: 'state',
    label: '$(circle-slash) Quitar el shiny',
    detail: '',
    run: () => ({ action: 'devSetShiny', value: false }),
  },
  {
    group: 'state',
    label: '$(question) Disfrazar de Ditto',
    detail: '1 entre 128. Se revela al alcanzar el primer umbral de evolución.',
    run: () => ({ action: 'devSetDitto', value: true }),
  },
  {
    group: 'state',
    label: '$(egg) Poner garantía al huevo…',
    detail: 'Simula haber comprado un huevo premium sin gastar',
    run: async () => {
      const picked = await vscode.window.showQuickPick(
        [
          { label: 'Sin garantía', tier: undefined },
          { label: 'Poco común o mejor', tier: 'uncommon' as const },
          { label: 'Raro o mejor', tier: 'rare' as const },
        ],
        { placeHolder: '¿Qué garantía?' },
      )
      if (picked === undefined) return undefined
      return picked.tier === undefined
        ? { action: 'devSetEggTier' }
        : { action: 'devSetEggTier', tier: picked.tier }
    },
  },

  // ---- edge cases the accounting has to survive ----
  {
    group: 'edge',
    label: '$(calendar) Simular cambio de día',
    detail: 'Fuerza la rama de rollover del libro mayor en el próximo refresco',
    run: () => ({ action: 'devDayRollover' }),
  },

  // ---- safety net ----
  {
    group: 'reset',
    label: '$(save) Guardar copia de la partida',
    detail: 'Punto al que volver antes de experimentar',
    run: () => ({ action: 'devSnapshot', slot: 'save' }),
  },
  {
    group: 'reset',
    label: '$(history) Restaurar la copia',
    detail: 'Vuelve al último punto guardado',
    run: () => ({ action: 'devSnapshot', slot: 'restore' }),
  },
  {
    group: 'reset',
    label: '$(trash) Empezar de cero',
    detail: 'Borra la partida y los tokens ficticios. Sin vuelta atrás salvo por la copia.',
    run: async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Se borrará la partida (Pokédex incluida).',
        { modal: true, detail: 'Los tokens ficticios también se limpian.' },
        'Borrar',
      )
      return confirm === 'Borrar' ? { action: 'devResetSave' } : undefined
    },
  },
]

const GROUP_LABELS: Record<Scenario['group'], string> = {
  tokens: 'Tokens (recorren el pipeline real)',
  items: 'Cartera y objetos',
  state: 'Estados improbables',
  edge: 'Casos límite de contabilidad',
  reset: 'Red de seguridad',
}

interface ScenarioItem extends vscode.QuickPickItem {
  scenario?: Scenario
}

/** Opens the picker and returns the actions to dispatch, in order. */
export async function pickScenario(): Promise<WorkerAction[]> {
  const items: ScenarioItem[] = []
  let group: Scenario['group'] | undefined
  for (const scenario of SCENARIOS) {
    if (scenario.group !== group) {
      group = scenario.group
      items.push({ label: GROUP_LABELS[group], kind: vscode.QuickPickItemKind.Separator })
    }
    items.push({ label: scenario.label, detail: scenario.detail, scenario })
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Tokendex · simulación de desarrollo',
    matchOnDetail: true,
  })
  if (picked?.scenario === undefined) return []

  const result = await picked.scenario.run()
  if (result === undefined) return []
  return Array.isArray(result) ? result : [result]
}
