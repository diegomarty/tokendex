/**
 * Localisation entries whose value is chosen by a switch rather than looked up.
 *
 * Written by hand because the mechanical extractor that produced `strings.ts` only handles
 * flat four-way tables.
 */

import type { AppLanguage, BallKind, ItemKind, Rarity } from '../companion/model.js'
import { Pokeball, RareCandy } from '../companion/model.js'
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
    case 'pokeBall':
      return t(lang, '몬스터볼', 'Poké Ball', 'モンスターボール', 'Poké Ball')
    case 'greatBall':
      return t(lang, '슈퍼볼', 'Great Ball', 'スーパーボール', 'Super Ball')
    case 'ultraBall':
      return t(lang, '하이퍼볼', 'Ultra Ball', 'ハイパーボール', 'Ultra Ball')
    case 'masterBall':
      return t(lang, '마스터볼', 'Master Ball', 'マスターボール', 'Master Ball')
  }
}

/**
 * A catch multiplier as a bare figure: `1.5`, and `1,5` where the comma is the decimal mark.
 *
 * Small, but it has to live here rather than at the two call sites: the shop's stat badge and
 * the ball's own sentence show the same number, and a Spanish reader must not meet `1,5` in
 * one and `1.5` in the other.
 */
function multiplierFigure(lang: AppLanguage, value: number): string {
  const plain = String(value)
  return t(lang, plain, plain, plain, plain.replace('.', ','))
}

/**
 * The catch multiplier as a stat, not a sentence.
 *
 * The ball rack on Home already prints a catch percentage under every ball, so a figure is the
 * house form for this fact; in the shop it replaces three sentences that differed only in their
 * number, and it lets a reader compare the rack at a glance instead of parsing prose. Derived
 * from `Pokeball.multiplier` — the same table `catchChance` rolls against.
 *
 * Absent for the Master Ball: its multiplier is `Infinity`, and an unconditional catch is not a
 * number. That one keeps its sentence, which is also the only ball copy that gives advice.
 */
export function ballCatchStat(lang: AppLanguage, kind: BallKind): string | undefined {
  const multiplier = Pokeball.multiplier[kind]
  if (!Number.isFinite(multiplier)) return undefined
  return `${multiplierFigure(lang, multiplier)}×`
}

/**
 * The accessible name behind `ballCatchStat` — a screen reader hearing "one point five times"
 * beside a ball's name has been told a number, not a fact.
 *
 * For the Great and Ultra Balls it is the sentence the badge replaced, which the bag still
 * shows in full. The Poké Ball has none of its own: its stat is the baseline the others are
 * quoted against, and that is what its label says.
 */
export function ballCatchLabel(lang: AppLanguage, kind: BallKind): string | undefined {
  if (!Number.isFinite(Pokeball.multiplier[kind])) return undefined
  if (kind === 'pokeBall') {
    return t(
      lang,
      '다른 볼의 포획률은 모두 이 볼을 기준으로 해요.',
      'The baseline every other ball is measured against.',
      'ほかのボールの基準になる捕獲率です。',
      'La referencia con la que se miden las demás balls.',
    )
  }
  return itemDescription(lang, kind)
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
    // Ball copy states the multiplier rather than a catch percentage: the real odds depend on
    // the species' capture rate, and a single number in the shop would be a lie for most of them.
    case 'pokeBall':
      return t(
        lang,
        '야생 포켓몬에게 던지는 기본 볼이에요.',
        'The standard ball for throwing at a wild Pokémon.',
        '野生のポケモンに投げる基本のボールです。',
        'La ball estándar para lanzar a un Pokémon salvaje.',
      )
    case 'greatBall':
    case 'ultraBall': {
      // Derived from the multiplier the dice actually use, like the candy's XP copy: a
      // hand-typed "1.5x" here would go on claiming 1.5 after a balance change.
      const m = multiplierFigure(lang, Pokeball.multiplier[kind])
      return t(
        lang,
        `몬스터볼보다 ${m}배 잘 잡혀요.`,
        `Catches ${m}× better than a Poké Ball.`,
        `モンスターボールより${m}倍つかまえやすい。`,
        `Captura ${m} veces mejor que una Poké Ball.`,
      )
    }
    case 'masterBall':
      return t(
        lang,
        '반드시 잡아요. 전설을 만났을 때를 위해 아껴 두세요.',
        'Never fails. Save it for a legendary.',
        'かならずつかまえられます。伝説のために取っておきましょう。',
        'Nunca falla. Guárdala para un legendario.',
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

/**
 * What an egg guarantees — and only that.
 *
 * All three shop eggs used to open with "Send off your current Pokémon…", almost verbatim. That
 * clause is the *price* the three share, not what separates them, so three cards spent their
 * first two lines saying the same thing and the reader had to reach the tail of each sentence
 * to find the one word that differed. The shared half is stated once, on the group heading
 * (`shopEggsNote`); what is left here is the only line that can change a choice.
 *
 * The guaranteed tiers delegate to `eggGuaranteeHint`, which says exactly this fact for the
 * incubation badge: the guarantee a card sells and the guarantee the egg then displays are one
 * sentence, so they cannot drift apart.
 */
export function eggDescription(lang: AppLanguage, tier: Rarity | undefined): string {
  if (tier === undefined || tier === 'common') {
    return t(lang, '등급은 무작위', 'Any rarity', 'レアリティはランダム', 'Rareza aleatoria')
  }
  return eggGuaranteeHint(lang, tier)
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
 * The bare noun, for lines that already carry their own number.
 *
 * The existing keys are whole phrases (`todayTokens`, `spendableTokens`), so the status bar
 * tooltip had the English word hard-coded in all four languages: a Japanese user read
 * `今日 · 253,400,000 tokens`.
 */
export function tokensNoun(lang: AppLanguage): string {
  return t(lang, '토큰', 'tokens', 'トークン', 'tokens')
}

/**
 * Status bar label for an egg.
 *
 * Separate from the panel's `eggIncubating` because the two say different things in different
 * places: the bar has room for a noun beside its codicon, the panel for a state under a drawn
 * egg. Neither carries an emoji of its own — both surfaces already draw one.
 */
export const statusEgg = (lang: AppLanguage): string => t(lang, '알', 'Egg', 'タマゴ', 'Huevo')

/** Tooltip command links. New to the extension: the macOS original has no tooltip. */
export const statusOpenPanel = (lang: AppLanguage): string =>
  t(lang, '패널 열기', 'Open panel', 'パネルを開く', 'Abrir el panel')

// MARK: - Wild encounters

export const runAwayLabel = (lang: AppLanguage): string => t(lang, '도망가기', 'Run', 'にげる', 'Huir')

export const trainerLabel = (lang: AppLanguage): string =>
  t(lang, '트레이너', 'Trainer', 'トレーナー', 'Entrenador')

/** Badge on a catch-log row that came from a wild capture rather than a raised line. */
export const wildCaughtBadge = (lang: AppLanguage): string => t(lang, '야생', 'wild', 'やせい', 'salvaje')

/**
 * Native confirmation before letting a wild Pokémon go. Built only for encounters worth the
 * friction — rare, legendary or shiny — so running from a Caterpie stays one click.
 */
export function runAwayConfirm(lang: AppLanguage, name: string): string {
  return t(
    lang,
    `야생 ${name}을(를) 보내줄까요?`,
    `Let the wild ${name} go?`,
    `やせいの${name}をにがしますか？`,
    `¿Dejar escapar al ${name} salvaje?`,
  )
}

export const refreshIntervalLabel = (lang: AppLanguage): string =>
  t(lang, '갱신 주기', 'Refresh interval', '更新間隔', 'Intervalo de actualización')

// MARK: - Shop

export const shopGroupBalls = (lang: AppLanguage): string =>
  t(lang, '몬스터볼', 'Poké Balls', 'ボール', 'Poké Balls')

export const shopGroupItems = (lang: AppLanguage): string => t(lang, '도구', 'Items', 'どうぐ', 'Objetos')

export const shopGroupEggs = (lang: AppLanguage): string => t(lang, '알', 'Eggs', 'タマゴ', 'Huevos')

/**
 * The one sentence every egg on sale shares, said once under the heading instead of three
 * times over on the cards. See `eggDescription` for what each card kept.
 */
export const shopEggsNote = (lang: AppLanguage): string =>
  t(
    lang,
    '어떤 알이든 지금 포켓몬을 놓아주고 부화를 처음부터 다시 시작해요.',
    'Every egg sends off your current Pokémon and starts incubation over.',
    'どのタマゴも、いまのポケモンを手放してふかをやり直します。',
    'Cualquier huevo suelta a tu Pokémon actual y reinicia la incubación.',
  )

/** The call-to-action under an empty ball rack — the moment of highest purchase intent. */
export const getBallsCta = (lang: AppLanguage): string =>
  t(lang, '몬스터볼 사러 가기', 'Get Poké Balls', 'ボールを買いに行く', 'Comprar Poké Balls')

/**
 * The saving marked on the ten-pack's own action.
 *
 * A figure, not a sentence, and deliberately the same figure in all four languages: a minus
 * sign and a percent read the same everywhere Tokendex does, and this sits inside a button
 * beside a price where a clause would not fit at sidebar width. The words a screen reader
 * hears instead are `bundleBuyLabel`'s.
 *
 * It takes the percentage rather than computing one, because the caller derives it from
 * `Pokeball.bundleMultiplier` / `bundleSize` — the same two constants `shopEntryPrice` divides
 * by. Advertising a discount the till does not give is the one failure this copy can have.
 */
export const bundleSaveText = (discountPercent: number): string => `−${discountPercent}%`

/**
 * Accessible name for a shop action.
 *
 * A row can now carry two of them — the single and the ten-pack — and a screen reader
 * announces a button by its own name, not by the card it sits in: two buttons both saying
 * "Buy" would be a coin toss. So the name carries what is being bought and what it costs.
 */
export const buyActionLabel = (lang: AppLanguage, name: string, price: string): string =>
  t(
    lang,
    `${name} 구매 — ${price}`,
    `Buy ${name} — ${price}`,
    `${name} を購入 — ${price}`,
    `Comprar ${name} — ${price}`,
  )

/** `buyActionLabel` for the ten-pack, spelling out the saving its `−10%` badge shows. */
export const bundleBuyLabel = (
  lang: AppLanguage,
  name: string,
  price: string,
  discountPercent: number,
): string =>
  t(
    lang,
    `${name} 구매 — ${price}, ${discountPercent}% 할인`,
    `Buy ${name} — ${price}, ${discountPercent}% off`,
    `${name} を購入 — ${price}、${discountPercent}%お得`,
    `Comprar ${name} — ${price}, ${discountPercent}% de descuento`,
  )

/** `buyActionLabel`'s counterpart for a passive already bought: the button is inert, and the
 *  word "Owned" alone does not say what is owned. */
export const ownedActionLabel = (lang: AppLanguage, name: string): string =>
  t(
    lang,
    `${name} — 보유 중`,
    `${name} — already owned`,
    `${name} — 所持済み`,
    `${name} — ya en posesión`,
  )

/**
 * The ten-pack's old sentence form, still read by the shop's current row builder.
 *
 * Superseded by `bundleBuyLabel` + `bundleSaveText`, which attach the saving to the action that
 * grants it instead of spending a description line on it. Kept until the panel builder moves
 * over.
 */
export function bundleDescription(lang: AppLanguage, size: number, discountPercent: number): string {
  return t(
    lang,
    `${size}개 묶음, ${discountPercent}% 할인.`,
    `${size} at once, ${discountPercent}% off.`,
    `${size}個セット、${discountPercent}%お得。`,
    `${size} de una vez, ${discountPercent}% de descuento.`,
  )
}

// MARK: - First run

/** Home's empty state before any AI CLI usage has been found. Brand names stay untranslated. */
export function noUsageText(lang: AppLanguage): string {
  const clis = 'Claude Code, Codex, Gemini, Grok, Antigravity, Cursor, Copilot, OpenCode, Hermes, Kiro'
  return t(
    lang,
    `아직 AI CLI 사용 기록을 찾지 못했어요. Tokendex가 읽는 로그: ${clis}.`,
    `No AI CLI usage found yet. Tokendex reads local logs from: ${clis}.`,
    `AI CLIの使用記録がまだ見つかりません。Tokendexが読むログ: ${clis}。`,
    `Aún no se ha encontrado uso de ningún CLI de IA. Tokendex lee los registros locales de: ${clis}.`,
  )
}

/** One-time toast on first activation, anchoring what the status bar item is. */
export function welcomeToast(lang: AppLanguage): string {
  return t(
    lang,
    'Tokendex가 로컬 AI 사용 기록을 읽는 중이에요 — 상태 표시줄에 알이 나타나요!',
    'Tokendex is reading your local AI usage — your egg appears in the status bar!',
    'Tokendexがローカルの AI 使用記録を読み込んでいます — ステータスバーにタマゴが現れます！',
    'Tokendex está leyendo tu uso local de IA — ¡tu huevo aparece en la barra de estado!',
  )
}

/**
 * Label on the progress bar toward the next wild encounter.
 *
 * It used to be a sentence announcing the empty state as well ("No wild Pokémon right now —
 * … tokens to the next."), from when it was a standalone paragraph. Beside a bar with its own
 * percentage it wrapped to two lines in a sidebar, and it was saying twice over what the empty
 * scene above it already shows. What is left is the half only this line can tell you, phrased
 * like its sibling `toNextEvolution` so the two read as one system.
 */
export function wildNextEncounterText(lang: AppLanguage, toNextAmount: string): string {
  return t(
    lang,
    `다음 출현까지 ${toNextAmount}`,
    `${toNextAmount} to the next encounter`,
    `次の出現まで${toNextAmount}`,
    `${toNextAmount} al siguiente encuentro`,
  )
}

/**
 * The streak row under the encounter bar: its accessible name, and the short line beside the
 * dots.
 *
 * Kept to a few characters on purpose. It shares a 300px sidebar row with seven dots, and the
 * sentence directly above it had to be cut down once already for wrapping to two lines there —
 * so this one says only what the dots cannot: how many of them count, and whether the week has
 * already paid out. Everything else (which days, how long the window is) is the drawing's job.
 */
export function streakRowLabel(lang: AppLanguage): string {
  return t(lang, '이번 주 연속', "This week's streak", 'こんしゅうのれんぞく', 'Racha semanal')
}

export function streakProgressText(lang: AppLanguage, days: number, needed: number): string {
  return t(
    lang,
    `${needed}일 중 ${days}일`,
    `${days} of ${needed} days`,
    `${needed}日のうち${days}日`,
    `${days} de ${needed} días`,
  )
}

/** Replaces the count once the week has paid out: there is nothing left to count toward. */
export function streakEarnedText(lang: AppLanguage): string {
  return t(lang, '전설 획득!', 'Legendary earned', 'でんせつ かくとく！', 'Legendario logrado')
}

// MARK: - Pokédex browsing

/**
 * The Pokédex is 649 cells — roughly 217 rows in a sidebar — so finding one entry by scrolling
 * is not a thing anyone does twice. These name the controls that replace the scroll.
 */
export function dexSearchPlaceholder(lang: AppLanguage): string {
  return t(lang, '이름 또는 번호', 'Name or number', '名前か番号', 'Nombre o número')
}

export function dexOwnedOnlyLabel(lang: AppLanguage): string {
  return t(lang, '보유한 것만', 'Owned only', '所持のみ', 'Solo obtenidos')
}

/** The chip that clears the catch log's rarity narrowing. */
export function dexFilterAllLabel(lang: AppLanguage): string {
  return t(lang, '전체', 'All', 'すべて', 'Todos')
}

export function dexNoMatchesText(lang: AppLanguage): string {
  return t(
    lang,
    '조건에 맞는 포켓몬이 없어요.',
    'No Pokémon match that.',
    '条件に合うポケモンがいません。',
    'Ningún Pokémon coincide.',
  )
}

/** The detail card's dismiss button — an icon, so this is its accessible name. */
export function closeLabel(lang: AppLanguage): string {
  return t(lang, '닫기', 'Close', '閉じる', 'Cerrar')
}

/** Heading over save export/import, so those two buttons stop reading as part of the roster. */
export function saveSectionTitle(lang: AppLanguage): string {
  return t(lang, '저장 데이터', 'Save data', 'セーブデータ', 'Partida guardada')
}

export function wildNoBallsText(lang: AppLanguage): string {
  return t(
    lang,
    '던질 볼이 없어요 — 상점에서 사 오세요.',
    'No balls to throw — buy some in the shop.',
    '投げるボールがありません — ショップで買いましょう。',
    'No tienes balls que lanzar — cómpralas en la tienda.',
  )
}

/** Tooltip on the activity-bar badge counting waiting encounters. */
export function wildBadgeTooltip(lang: AppLanguage, count: number): string {
  return t(
    lang,
    `야생 포켓몬 ${count}마리가 기다리고 있어요`,
    count === 1 ? 'A wild Pokémon is waiting' : `${count} wild Pokémon are waiting`,
    `野生のポケモンが${count}匹待っています`,
    count === 1 ? 'Un Pokémon salvaje te espera' : `${count} Pokémon salvajes te esperan`,
  )
}

/** The scene's result line for a ball that failed. `shakes` is how close it came, 0..3. */
export function brokeFreeText(lang: AppLanguage, shakes: number): string {
  if (shakes >= 3) {
    return t(
      lang,
      '아깝다! 거의 잡을 뻔했는데!',
      'Shoot! It was so close, too!',
      'ああ！おしかった！',
      '¡Ah! ¡Casi lo tenías!',
    )
  }
  return t(
    lang,
    '앗, 나와버렸다!',
    'Oh no! It broke free!',
    'だめだ！ボールから出てしまった！',
    '¡Oh no! ¡Se ha liberado!',
  )
}

export function fledText(lang: AppLanguage, name: string): string {
  return t(
    lang,
    `야생 ${name}은(는) 도망가 버렸다…`,
    `The wild ${name} fled…`,
    `やせいの${name}はにげてしまった…`,
    `¡El ${name} salvaje ha huido…!`,
  )
}

// MARK: - Celebrations

/**
 * Structural mirror of `CompanionEvent` (plus the worker-emitted candy grant), so this module
 * needs no import from the companion store. The store's variants carry extra fields
 * (speciesID) and stay assignable.
 *
 * `wildCaught` has no `CompanionEvent` twin on purpose: a catch never toasts (the player is
 * watching the animation). The copy lives here for the throw-outcome text the worker sends
 * back to the panel.
 */
export type CelebrationEvent =
  | { kind: 'hatched'; name: string; isShiny: boolean }
  | { kind: 'evolved'; name: string }
  | { kind: 'graduated'; name: string }
  | { kind: 'dittoRevealed'; disguisedAs: string; isShiny: boolean }
  | { kind: 'candyGranted'; count: number; windowName: string }
  | { kind: 'wildAppeared'; name: string; rarity: Rarity; isShiny: boolean }
  | { kind: 'wildCaught'; name: string; isShiny: boolean }
  /**
   * A guaranteed legendary was earned. `via` is a union rather than two independent flags so
   * the combined case has to be *written*, not composed: both triggers can fire in one fold,
   * and two toasts in the same second for one piece of work read as a bug. A third trigger
   * must decide here what it says alongside each of the others.
   */
  | { kind: 'legendaryEarned'; via: 'streak'; days: number }
  | { kind: 'legendaryEarned'; via: 'milestone'; tokens: number }
  | { kind: 'legendaryEarned'; via: 'both'; days: number; tokens: number }

/**
 * Toast copy for the game's peak moments — the events `drainEvents` accumulates.
 *
 * Having copy here does **not** mean a toast is shown: `wildAppeared` fires on every encounter,
 * and the host filters it down to shinies and legendaries at most once an hour. The panel and
 * the activity-bar badge are where an ordinary encounter surfaces.
 */
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
    case 'wildAppeared': {
      const text = t(
        lang,
        `야생 ${event.name}이(가) 나타났어요!`,
        `A wild ${event.name} appeared!`,
        `やせいの${event.name}があらわれた！`,
        `¡Un ${event.name} salvaje apareció!`,
      )
      return event.isShiny ? `${text} ✨` : text
    }
    case 'wildCaught': {
      const text = t(
        lang,
        `${event.name}을(를) 잡았어요!`,
        `Gotcha! ${event.name} was caught!`,
        `やった！${event.name}をつかまえた！`,
        `¡Bien! ¡${event.name} ha sido capturado!`,
      )
      return event.isShiny ? `${text} ✨` : text
    }
    // "On its way", not "has appeared": the reward is owed the moment it is earned, but the
    // species is only rolled when there is room in the queue and a species index to roll from.
    // The wild Pokémon announces itself separately, by name, once it is actually there.
    case 'legendaryEarned':
      switch (event.via) {
        case 'streak':
          return t(
            lang,
            `최근 ${event.days}일 동안 작업했어요 — 전설의 포켓몬이 다가오고 있어요!`,
            `${event.days} days of work this week — a legendary is on its way!`,
            `このところ${event.days}日はたらいた — でんせつのポケモンがちかづいてくる！`,
            `${event.days} días de trabajo esta semana: un legendario está en camino.`,
          )
        case 'milestone':
          return t(
            lang,
            `누적 ${compact(event.tokens)} 토큰 돌파 — 전설의 포켓몬이 다가오고 있어요!`,
            `${compact(event.tokens)} tokens used in all — a legendary is on its way!`,
            `つうさん${compact(event.tokens)}トークン とっぱ — でんせつのポケモンがちかづいてくる！`,
            `${compact(event.tokens)} tokens en total: un legendario está en camino.`,
          )
        // One achievement, not the two single lines glued together: the week and the lifetime
        // total are one sentence, and it says two legendaries are coming because two are owed.
        case 'both':
          return t(
            lang,
            `최근 ${event.days}일 작업에 누적 ${compact(event.tokens)} 토큰 돌파 — 전설의 포켓몬 2마리가 다가오고 있어요!`,
            `${event.days} days of work and ${compact(event.tokens)} tokens used — two legendaries are on their way!`,
            `このところ${event.days}日はたらき つうさん${compact(event.tokens)}トークンもとっぱ — でんせつのポケモンが2ひきちかづいてくる！`,
            `${event.days} días de trabajo y ${compact(event.tokens)} tokens en total: dos legendarios están en camino.`,
          )
      }
  }
}

/** The celebration toast's single button. */
export function openPanelLabel(lang: AppLanguage): string {
  return t(lang, '패널 열기', 'Open panel', 'パネルをひらく', 'Abrir panel')
}

/**
 * Shown when a user action could not take the save's cross-window lock and was therefore not
 * applied at all.
 *
 * Every open window writes one `companion-state.json`, and a mutation that cannot get the
 * lock inside its deadline writes nothing (`docs/multi-window.md` §5(d)). An *accrual* in
 * that position simply skips — the tokens stay unclaimed and fold on the next tick — but a
 * purchase, a throw or a language change has to say so: a Master Ball that was never bought
 * must never look bought. The copy is explicit that nothing changed, because the failure the
 * user can actually act on is "try again", not "something went wrong".
 */
export function saveBusyText(lang: AppLanguage): string {
  return t(
    lang,
    '다른 창이 저장 파일을 쓰고 있어서 아무것도 바뀌지 않았어요. 잠시 후 다시 시도해 주세요.',
    'Another window was writing your save, so nothing was changed. Try again in a moment.',
    'ほかのウィンドウがセーブデータを書きこんでいたため、なにも変更されていません。少しあとでもう一度おためしください。',
    'Otra ventana estaba escribiendo tu partida, así que no se cambió nada. Inténtalo de nuevo.',
  )
}
