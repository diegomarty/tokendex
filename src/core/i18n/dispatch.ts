/**
 * Localisation entries whose value is chosen by a switch rather than looked up.
 *
 * Written by hand because the mechanical extractor that produced `strings.ts` only handles
 * flat four-way tables.
 */

import type { AppLanguage, ItemKind, Rarity } from '../companion/model.js'
import { RareCandy } from '../companion/model.js'
import { compact } from '../tokenFormatter.js'
import { s } from './strings.js'

const INDEX: Record<AppLanguage, 0 | 1 | 2 | 3> = { ko: 0, en: 1, ja: 2, es: 3 }
const t = (lang: AppLanguage, ko: string, en: string, ja: string, es: string): string =>
  [ko, en, ja, es][INDEX[lang]]!

export type ProviderStatusIndicator =
  'operational' | 'minor' | 'major' | 'critical' | 'maintenance' | 'unknown'

export function providerStatusLabel(lang: AppLanguage, indicator: ProviderStatusIndicator): string {
  switch (indicator) {
    case 'operational':
      return t(lang, '정상', 'Operational', '正常', 'Operativo')
    case 'minor':
      return t(lang, '일부 장애', 'Minor issues', '一部障害', 'Problemas menores')
    case 'major':
      return t(lang, '장애', 'Major outage', '障害', 'Interrupción grave')
    case 'critical':
      return t(lang, '심각한 장애', 'Critical outage', '重大障害', 'Interrupción crítica')
    case 'maintenance':
      return t(lang, '점검 중', 'Maintenance', 'メンテナンス', 'Mantenimiento')
    case 'unknown':
      return t(lang, '상태 불명', 'Status unknown', '状態不明', 'Estado desconocido')
  }
}

export const plan = (lang: AppLanguage, p: string): string =>
  t(lang, `플랜 ${p}`, `Plan ${p}`, `プラン ${p}`, `Plan ${p}`)

export const percentRemaining = (lang: AppLanguage, percent: string): string =>
  t(lang, `${percent} 남음`, `${percent} left`, `残り${percent}`, `${percent} restante`)

export const stage = (lang: AppLanguage, i: number, k: number): string =>
  t(lang, `진화 단계 ${i} / ${k}`, `Stage ${i} / ${k}`, `進化段階 ${i} / ${k}`, `Etapa ${i} / ${k}`)

export const statusEvolved = (lang: AppLanguage, name: string): string =>
  t(
    lang,
    `${name}(으)로 진화했어요!`,
    `Evolved into ${name}!`,
    `${name} に進化しました！`,
    `¡Evolucionó a ${name}!`,
  )

export const buyConfirm = (lang: AppLanguage, name: string): string =>
  t(lang, `${name} 구매할까요?`, `Buy ${name}?`, `${name} を購入しますか？`, `¿Comprar ${name}?`)

/** Names for the new-limits `limits[]` entries, from kind plus model scope. */
export function claudeLimitEntry(
  lang: AppLanguage,
  kind: string | undefined,
  model: string | undefined,
): string {
  switch (kind) {
    case 'session':
      return s(lang, 'fiveHourSession')
    case 'weekly_all':
      return s(lang, 'weekly')
    case 'weekly_scoped':
      // Without a model name this would collide with the legacy "weekly" row, so say scoped.
      if (model === undefined) {
        return t(lang, '주간 (모델별)', 'Weekly (scoped)', '週間（モデル別）', 'Semanal (por modelo)')
      }
      return t(lang, `주간 ${model}`, `Weekly ${model}`, `週間 ${model}`, `Semanal ${model}`)
    default: {
      const base = kind ?? 'limit'
      const name = model === undefined ? '' : ` ${model}`
      return base.replaceAll('_', ' ') + name
    }
  }
}

/** Codex limit window name, from windowDurationMins. Shared by notifications and the panel. */
export function codexWindow(lang: AppLanguage, mins: number | undefined): string {
  if (mins === undefined) return t(lang, '한도', 'Limit', '上限', 'Límite')
  if (mins === 300) return s(lang, 'fiveHourSession')
  if (mins === 10_080) return s(lang, 'weekly')
  if (mins >= 60 && mins % 60 === 0) {
    const h = mins / 60
    return t(lang, `${h}시간`, `${h}h`, `${h}時間`, `${h}h`)
  }
  return t(lang, `${mins}분`, `${mins}m`, `${mins}分`, `${mins}m`)
}

/** Refresh interval label, in seconds. Zero means manual. */
export function intervalLabel(lang: AppLanguage, seconds: number): string {
  if (seconds === 0) return t(lang, '수동', 'Manual', '手動', 'Manual')
  const m = Math.trunc(seconds / 60)
  return t(lang, `${m}분`, `${m} min`, `${m}分`, `${m} min`)
}

export function rarityLabel(lang: AppLanguage, rarity: Rarity): string {
  switch (rarity) {
    case 'common':
      return s(lang, 'rarityCommon')
    case 'uncommon':
      return s(lang, 'rarityUncommon')
    case 'rare':
      return s(lang, 'rarityRare')
    case 'legendary':
      return s(lang, 'rarityLegendary')
  }
}

export function itemName(lang: AppLanguage, kind: ItemKind): string {
  switch (kind) {
    case 'rareCandy':
      return t(lang, '이상한 사탕', 'Rare Candy', 'ふしぎなアメ', 'Caramelo Raro')
    case 'mint':
      return t(lang, '민트', 'Mint', 'ミント', 'Menta')
    case 'shinyCharm':
      return t(lang, '이로치 부적', 'Shiny Charm', 'ひかるおまもり', 'Amuleto Iris')
  }
}

export function itemDescription(lang: AppLanguage, kind: ItemKind): string {
  switch (kind) {
    case 'rareCandy': {
      // Derived from the constant so the copy cannot drift from the balance value.
      const xp = compact(RareCandy.xp)
      return t(
        lang,
        `현재 포켓몬의 경험치를 ${xp} 올려줘요.`,
        `Raises your Pokémon's EXP by ${xp}.`,
        `ポケモンの経験値を${xp}上げます。`,
        `Aumenta la experiencia de tu Pokémon en ${xp}.`,
      )
    }
    case 'mint':
      return t(
        lang,
        '현재 포켓몬의 성격을 랜덤으로 바꿔줘요.',
        "Randomly changes your Pokémon's nature.",
        'ポケモンのせいかくをランダムに変えます。',
        'Cambia aleatoriamente la naturaleza de tu Pokémon.',
      )
    case 'shinyCharm':
      return t(
        lang,
        '보유하면 이로치 포켓몬이 태어날 확률이 올라가요.',
        'While owned, raises the chance of hatching a shiny.',
        '持っていると色違いが生まれる確率が上がります。',
        'Mientras lo tengas, aumenta la probabilidad de que nazca un Pokémon variocolor.',
      )
  }
}

/**
 * Egg names are written out per language rather than composed as `rarityLabel + " egg"`:
 * Korean and English would compose fine, but Japanese particles come out wrong
 * (レアのタマゴ versus the natural レアなタマゴ).
 */
export function eggName(lang: AppLanguage, tier: Rarity | undefined): string {
  switch (tier) {
    case undefined:
    case 'common':
      return t(lang, '포켓몬 알', 'Pokémon Egg', 'ポケモンのタマゴ', 'Huevo Pokémon')
    case 'uncommon':
      return t(lang, '고급 알', 'Uncommon Egg', 'アンコモンのタマゴ', 'Huevo poco común')
    case 'rare':
      return t(lang, '희귀 알', 'Rare Egg', 'レアのタマゴ', 'Huevo raro')
    case 'legendary':
      // Not sold (see FreshEgg.shopTiers), but named for completeness.
      return t(lang, '전설 알', 'Legendary Egg', 'でんせつのタマゴ', 'Huevo legendario')
  }
}

export function eggDescription(lang: AppLanguage, tier: Rarity | undefined): string {
  if (tier === undefined || tier === 'common') {
    return t(
      lang,
      '지금 포켓몬을 놓아주고 새 알로 다시 시작해요.',
      'Send off your current Pokémon and start fresh with a new egg.',
      'いまのポケモンを手放して新しいタマゴからやり直します。',
      'Suelta a tu Pokémon actual y empieza de nuevo con un huevo nuevo.',
    )
  }
  const r = rarityLabel(lang, tier)
  return t(
    lang,
    `지금 포켓몬을 놓아주고 ${r} 이상이 확정으로 나오는 알을 받아요.`,
    `Send off your current Pokémon for an egg guaranteed to hatch ${r} or better.`,
    `いまのポケモンを手放して ${r} 以上が確定で孵るタマゴをもらいます。`,
    `Suelta a tu Pokémon actual y consigue un huevo garantizado de ${r} o superior.`,
  )
}

/** Badge shown while incubating, naming the guarantee in one line. */
export function eggGuaranteeHint(lang: AppLanguage, tier: Rarity): string {
  const r = rarityLabel(lang, tier)
  return t(lang, `${r} 이상 확정`, `${r} or better`, `${r} 以上確定`, `${r} o superior garantizado`)
}

export const eggConfirm = (lang: AppLanguage, monName: string, egg: string): string =>
  t(
    lang,
    `${monName}을(를) 놓아주고 ${egg}(으)로 바꿀까요?`,
    `Send off ${monName} for the ${egg}?`,
    `${monName} を手放して ${egg} にしますか？`,
    `¿Soltar a ${monName} y cambiarlo por ${egg}?`,
  )

/**
 * Column header for the per-provider table.
 *
 * This string is new to the extension, so it is hand-written rather than generated.
 * Hand-written strings live here rather than in `strings.ts`, which is generated and would
 * overwrite them.
 */
export const providerColumn = (lang: AppLanguage): string =>
  t(lang, '도구', 'Tool', 'ツール', 'Herramienta')

/**
 * The two row labels in the status-bar tooltip.
 *
 * They live here rather than in `strings.ts` because that file is generated. The tooltip's
 * other lines already arrive localised, so hard-coding these would put two languages inside
 * one tooltip — which is exactly what it used to do.
 */
export function tooltipToday(lang: AppLanguage): string {
  return t(lang, '오늘', 'Today', '今日', 'Hoy')
}

export function tooltipMonth(lang: AppLanguage): string {
  return t(lang, '이번 달', 'Month', '今月', 'Mes')
}

/**
 * Status bar label for an egg. The panel's `eggIncubating` carries a 🥚 emoji, which would sit
 * next to the egg codicon and read as two eggs, so the bar gets its own plain word.
 */
export const statusEgg = (lang: AppLanguage): string => t(lang, '알', 'Egg', 'タマゴ', 'Huevo')

/** Tooltip command links. New to the extension: the macOS original has no tooltip. */
export const statusOpenPanel = (lang: AppLanguage): string =>
  t(lang, '패널 열기', 'Open panel', 'パネルを開く', 'Abrir el panel')

// MARK: - Celebrations

/**
 * Structural mirror of `CompanionEvent` (plus the worker-emitted candy grant), so this module
 * needs no import from the companion store. The store's variants carry extra fields
 * (speciesID) and stay assignable.
 */
export type CelebrationEvent =
  | { kind: 'hatched'; name: string; isShiny: boolean }
  | { kind: 'evolved'; name: string }
  | { kind: 'graduated'; name: string }
  | { kind: 'dittoRevealed'; disguisedAs: string; isShiny: boolean }
  | { kind: 'candyGranted'; count: number; windowName: string }

/** Toast copy for the game's peak moments — the events `drainEvents` accumulates. */
export function celebrationText(lang: AppLanguage, event: CelebrationEvent): string {
  switch (event.kind) {
    case 'hatched': {
      const text = t(
        lang,
        `알에서 ${event.name}이(가) 태어났어요!`,
        `${event.name} hatched from the egg!`,
        `タマゴから${event.name}がうまれた！`,
        `¡${event.name} ha salido del huevo!`,
      )
      return event.isShiny ? `${text} ✨` : text
    }
    case 'evolved':
      return t(
        lang,
        `${event.name}(으)로 진화했어요!`,
        `Evolved into ${event.name}!`,
        `${event.name}にしんかした！`,
        `¡Ha evolucionado a ${event.name}!`,
      )
    case 'graduated':
      return t(
        lang,
        `${event.name}이(가) 도감에 등록되었어요!`,
        `${event.name} graduated into the Pokédex!`,
        `${event.name}がずかんにとうろくされた！`,
        `¡${event.name} se ha graduado a la Pokédex!`,
      )
    case 'dittoRevealed': {
      const text = t(
        lang,
        `${event.disguisedAs}은(는) 사실 메타몽이었어요!`,
        `It was Ditto all along, disguised as ${event.disguisedAs}!`,
        `${event.disguisedAs}はメタモンだった！`,
        `¡Era Ditto disfrazado de ${event.disguisedAs}!`,
      )
      return event.isShiny ? `${text} ✨` : text
    }
    case 'candyGranted':
      return t(
        lang,
        `${itemName(lang, 'rareCandy')} ×${event.count} 획득 — ${event.windowName}`,
        `${itemName(lang, 'rareCandy')} ×${event.count} earned — ${event.windowName}`,
        `${itemName(lang, 'rareCandy')} ×${event.count} かくとく — ${event.windowName}`,
        `${itemName(lang, 'rareCandy')} ×${event.count} — ${event.windowName}`,
      )
  }
}

/** The celebration toast's single button. */
export function openPanelLabel(lang: AppLanguage): string {
  return t(lang, '패널 열기', 'Open panel', 'パネルをひらく', 'Abrir panel')
}
