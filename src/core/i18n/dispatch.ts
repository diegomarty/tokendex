/**
 * Localisation entries whose value is chosen by a switch rather than looked up.
 *
 * Written by hand because the mechanical extractor that produced `strings.ts` only handles
 * flat four-way tables.
 */

import type {
  AppLanguage,
  BallKind,
  BerryKind,
  ItemKind,
  PokemonType,
  Rarity,
} from '../companion/model.js'
import { Pokeball, RareCandy, isBallKind } from '../companion/model.js'
import type { TurnOutcome } from '../companion/encounters.js'
import { compact } from '../tokenFormatter.js'
import { s } from './strings.js'
import type { RegionID } from '../companion/regions.js'
import { type Challenge, challengeReward } from '../companion/challenges.js'

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
  t(lang, `${name} 구매할까요?`, `Buy ${name}?`, `${name}を かいますか？`, `¿Comprar ${name}?`)

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
    case 'oranBerry':
      return t(lang, '오랭열매', 'Oran Berry', 'オレンのみ', 'Baya Aranja')
    case 'nanabBerry':
      return t(lang, '나나열매', 'Nanab Berry', 'ナナのみ', 'Baya Latano')
    case 'razzBerry':
      return t(lang, '라즈열매', 'Razz Berry', 'ズリのみ', 'Baya Frambu')
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

/** The bag's hint when the species on stage has had all the candies it will take. */
export function candyFullHint(lang: AppLanguage): string {
  const max = RareCandy.maxPerSpecies
  return t(
    lang,
    `이 종은 이미 사탕을 ${max}개 먹었어요. 다음 모습은 다시 먹을 수 있어요.`,
    `This species has had its ${max} candies; its next form can take more.`,
    `この種はもうアメを${max}個食べました。次の姿ならまた食べられます。`,
    `Esta especie ya tomó sus ${max} caramelos; su siguiente forma podrá tomar más.`,
  )
}

export function itemDescription(lang: AppLanguage, kind: ItemKind): string {
  switch (kind) {
    case 'rareCandy': {
      // Derived from the constants so the copy cannot drift from what a candy actually does.
      const share = Math.round(RareCandy.stageShare * 100)
      const max = RareCandy.maxPerSpecies
      return t(
        lang,
        `현재 단계 경험치의 ${share}%만큼 올려줘요. 종마다 최대 ${max}개.`,
        `Raises your Pokémon's EXP by ${share}% of its current stage. At most ${max} per species.`,
        `いまの段階の経験値を${share}%ぶん上げます。1種につき${max}個まで。`,
        `Aumenta la experiencia de tu Pokémon un ${share}% de su etapa actual. Máximo ${max} por especie.`,
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
        'Mientras lo tengas, aumenta la probabilidad de que nazca un Pokémon shiny.',
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
    // Berries say what they do to the Pokémon, not by how much: the effect scales with each
    // species' appetite, so any figure here would be wrong for most of them.
    case 'oranBerry':
      return t(
        lang,
        '야생 포켓몬에게 주면 화가 가라앉고 경계를 풀어요.',
        'Give it to a wild Pokémon to calm its anger and earn its trust.',
        '野生のポケモンにあげると、怒りがおさまり心を許します。',
        'Dásela a un Pokémon salvaje para calmar su enfado y ganarte su confianza.',
      )
    case 'nanabBerry':
      return t(
        lang,
        '야생 포켓몬에게 주면 긴장이 풀려서 잘 도망가지 않아요.',
        'Give it to a wild Pokémon to settle its nerves, so it is less likely to flee.',
        '野生のポケモンにあげると、落ち着いて逃げにくくなります。',
        'Dásela a un Pokémon salvaje para calmar sus nervios: huirá con menos facilidad.',
      )
    case 'razzBerry':
      return t(
        lang,
        '야생 포켓몬에게 주면 다음에 던지는 볼이 잘 잡혀요.',
        'Give it to a wild Pokémon and your next ball catches more easily.',
        '野生のポケモンにあげると、次に投げるボールでつかまえやすくなります。',
        'Dásela a un Pokémon salvaje y tu siguiente ball capturará con más facilidad.',
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
  if (tier === undefined) {
    return t(lang, '보관함에 추가', 'Goes to your stock', 'ストックに くわわる', 'Va a tu reserva')
  }
  if (tier === 'common') {
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

/** The battle menu's Pokémon button, as the games print it: the companion's entry. */
export const pokemonMenuLabel = (lang: AppLanguage): string =>
  t(lang, '포켓몬', 'Pokémon', 'ポケモン', 'Pokémon')

export const trainerLabel = (lang: AppLanguage): string =>
  t(lang, '트레이너', 'Trainer', 'トレーナー', 'Entrenador')

/** Badge on a catch-log row that came from a wild capture rather than a raised line. */
export const wildCaughtBadge = (lang: AppLanguage): string => t(lang, '야생', 'Wild', 'やせい', 'Salvaje')

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

/** The dialog box's prompt while the battle menu waits for a command, as the games ask it. */
export const commandPrompt = (lang: AppLanguage): string =>
  t(lang, '무엇을 할까?', 'What will you do?', 'どうする？', '¿Qué vas a hacer?')

export const commandBalls = (lang: AppLanguage): string => t(lang, '볼', 'Balls', 'ボール', 'Poké Balls')

export const commandBack = (lang: AppLanguage): string => t(lang, '뒤로', 'Back', 'もどる', 'Atrás')

export const shopGroupBerries = (lang: AppLanguage): string =>
  t(lang, '열매', 'Berries', 'きのみ', 'Bayas')

export const shopGroupItems = (lang: AppLanguage): string => t(lang, '도구', 'Items', 'どうぐ', 'Objetos')

export const shopGroupEggs = (lang: AppLanguage): string => t(lang, '알', 'Eggs', 'タマゴ', 'Huevos')

/**
 * The one sentence every egg on sale shares, said once under the heading instead of three
 * times over on the cards. See `eggDescription` for what each card kept.
 */
export const shopEggsNote = (lang: AppLanguage): string =>
  t(
    lang,
    '알은 보관함으로 가요. 보장은 품고 있는 알의 등급을 정해요.',
    'An egg goes to your stock; a guarantee fixes the rarity of the egg you are incubating.',
    'タマゴは ストックへ。ほしょうは あたためている タマゴの レアリティを きめます。',
    'El huevo va a tu reserva; la garantía fija la rareza del que estás incubando.',
  )

/** The call-to-action under an empty ball rack — the moment of highest purchase intent. */
export const getBallsCta = (lang: AppLanguage): string =>
  t(lang, '몬스터볼 사러 가기', 'Get Poké Balls', 'ボールを買いに行く', 'Ir a por Poké Balls')

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
    `${name}を かう — ${price}`,
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
    `${name}を かう — ${price}、${discountPercent}%お得`,
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
    `${days} / ${needed} days`,
    `${days} / ${needed}日`,
    `${days} / ${needed} días`,
  )
}

/** Replaces the count once the week has paid out: there is nothing left to count toward. */
export function streakEarnedText(lang: AppLanguage): string {
  return t(lang, '전설 획득!', 'Legendary earned!', 'でんせつ かくとく！', '¡Legendario conseguido!')
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
  return t(lang, '보유한 것만', 'Obtained only', '所持のみ', 'Solo obtenidos')
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

/**
 * The scene's result line for one turn, pre-localised — the webview never composes text. Present
 * tense theatre, matching the games: "Gotcha!", "It broke free!", "It fled…", with whatever the
 * Pokémon did in reply appended as its own sentence.
 *
 * The outcome is taken structurally, like `CelebrationEvent`, so this module stays free of the
 * encounter engine.
 */
export function turnResultText(
  lang: AppLanguage,
  outcome:
    | Omit<Extract<TurnOutcome, { kind: 'caught' }>, 'shakes'>
    | { kind: 'broke'; shakes: number; attack?: { stolen: number } }
    | { kind: 'fed'; berry: BerryKind; attack?: { stolen: number } }
    | { kind: 'fled'; trailed: boolean }
    | { kind: 'noItem' }
    | { kind: 'unknownEncounter' },
  context: { name: string; isShiny: boolean; item: ItemKind; trailHours: number },
): string {
  const attack = (a: { stolen: number } | undefined) =>
    a === undefined
      ? ''
      : ` ${attackedText(lang, context.name, a.stolen > 0 ? compact(a.stolen) : undefined)}`
  switch (outcome.kind) {
    case 'caught': {
      const line = celebrationText(lang, {
        kind: 'wildCaught',
        name: context.name,
        isShiny: context.isShiny,
      })
      const parts = [line]
      if (outcome.registeredPercent !== undefined)
        parts.push(caughtRegisteredText(lang, outcome.registeredPercent))
      if (outcome.reward !== undefined) parts.push(duplicateRewardText(lang, compact(outcome.reward)))
      if (outcome.refunded > 0) parts.push(refundedText(lang, compact(outcome.refunded)))
      // Japanese runs sentences together after 。/！; the others separate them with a space.
      return parts.join(lang === 'ja' ? '' : ' ')
    }
    case 'broke':
      return `${brokeFreeText(lang, outcome.shakes)}${attack(outcome.attack)}`
    case 'fed':
      return `${fedText(lang, context.name, outcome.berry)}${attack(outcome.attack)}`
    case 'fled': {
      const line = fledText(lang, context.name)
      return outcome.trailed ? `${line} ${trailLeftText(lang, context.trailHours)}` : line
    }
    case 'noItem':
      return isBallKind(context.item)
        ? wildNoBallsText(lang)
        : noBerryText(lang, itemName(lang, context.item))
    case 'unknownEncounter':
      return '' // the state push already removed the scene
  }
}

/** The trail line added to a legendary's flee: it can still be tracked, and for how long. */
export function trailLeftText(lang: AppLanguage, hours: number): string {
  const h = Math.round(hours)
  return t(
    lang,
    `흔적이 ${h}시간 동안 남아 있어요.`,
    `Its trail will stay for ${h} h.`,
    `あしあとが ${h}時間 のこっています。`,
    `Su rastro seguirá ${h} h.`,
  )
}

/** It struck back. `stolen` is already formatted; empty when the wallet had nothing to take. */
export function attackedText(lang: AppLanguage, name: string, stolen: string | undefined): string {
  if (stolen === undefined) {
    return t(
      lang,
      `야생 ${name}의 공격! 하지만 가져갈 게 없었어요.`,
      `The wild ${name} attacked! But it found nothing to take.`,
      `やせいの${name}のこうげき！でも、とれるものはなかった。`,
      `¡El ${name} salvaje te ha atacado! Pero no encontró nada que llevarse.`,
    )
  }
  return t(
    lang,
    `야생 ${name}의 공격! 토큰 ${stolen}을(를) 빼앗겼어요.`,
    `The wild ${name} attacked! It took ${stolen} tokens.`,
    `やせいの${name}のこうげき！トークンを${stolen}とられた。`,
    `¡El ${name} salvaje te ha atacado! Se ha llevado ${stolen} tokens.`,
  )
}

/** What a berry did, as the scene's result line. */
export function fedText(lang: AppLanguage, name: string, berry: BerryKind): string {
  switch (berry) {
    case 'oranBerry':
      return t(
        lang,
        `${name}은(는) 오랭열매를 먹고 진정했어요.`,
        `${name} ate the Oran Berry and calmed down.`,
        `${name}はオレンのみを食べて落ち着いた。`,
        `${name} se ha comido la Baya Aranja y se ha calmado.`,
      )
    case 'nanabBerry':
      return t(
        lang,
        `${name}은(는) 나나열매를 먹고 긴장이 풀렸어요.`,
        `${name} ate the Nanab Berry and settled down.`,
        `${name}はナナのみを食べてリラックスした。`,
        `${name} se ha comido la Baya Latano y está más tranquilo.`,
      )
    case 'razzBerry':
      return t(
        lang,
        `${name}은(는) 라즈열매를 먹었어요. 다음 볼이 잘 잡혀요!`,
        `${name} ate the Razz Berry. Your next ball will catch more easily!`,
        `${name}はズリのみを食べた。次のボールでつかまえやすい！`,
        `${name} se ha comido la Baya Frambu. ¡Tu próxima ball capturará mejor!`,
      )
  }
}

/** The bag held none of the berry that was offered. */
export function noBerryText(lang: AppLanguage, berryName: string): string {
  return t(
    lang,
    `${berryName}이(가) 없어요.`,
    `You have no ${berryName} left.`,
    `${berryName}がありません。`,
    `No te queda ninguna ${berryName}.`,
  )
}

/** Tokens a catch paid back, appended to the catch line. */
export function refundedText(lang: AppLanguage, amount: string): string {
  return t(
    lang,
    `빼앗긴 토큰 ${amount}을(를) 되찾았어요.`,
    `You got your ${amount} tokens back.`,
    `とられたトークン${amount}をとりかえした。`,
    `Has recuperado tus ${amount} tokens.`,
  )
}

/**
 * The encounter's character in a few words: its nature and whichever traits stand out. The
 * thresholds are the same ones the meters' tones use, so the words and the bars agree.
 */
export function temperamentText(
  lang: AppLanguage,
  natureLabel: string | undefined,
  traits: { aggressive: boolean; gentle: boolean; skittish: boolean; steady: boolean; hungry: boolean },
): string {
  const words: string[] = []
  if (natureLabel !== undefined) words.push(natureLabel)
  if (traits.aggressive) words.push(t(lang, '사나움', 'fierce', 'あらっぽい', 'fiero'))
  if (traits.gentle) words.push(t(lang, '온화함', 'mild-tempered', 'おだやか', 'apacible'))
  if (traits.skittish) words.push(t(lang, '겁이 많음', 'skittish', 'びくびく', 'asustadizo'))
  if (traits.steady) words.push(t(lang, '침착함', 'unflappable', 'どっしり', 'impasible'))
  if (traits.hungry) words.push(t(lang, '먹보', 'hungry', 'くいしんぼう', 'glotón'))
  return words.join(' · ')
}

export function moodMeterLabel(lang: AppLanguage, meter: 'anger' | 'nervousness' | 'trust'): string {
  switch (meter) {
    case 'anger':
      return t(lang, '분노', 'Anger', 'いかり', 'Enfado')
    case 'nervousness':
      return t(lang, '긴장', 'Nerves', 'きんちょう', 'Nervios')
    case 'trust':
      return t(lang, '신뢰', 'Trust', 'しんらい', 'Confianza')
  }
}

/** What a miss risks, from the same permille the reaction roll is held to. */
export function riskText(lang: AppLanguage, flee: string, attack: string): string {
  return `${riskHeading(lang)}${t(lang, ': ', ': ', '：', ': ')}${riskFlee(lang, flee)} · ${riskAttack(lang, attack)}`
}

/** The parts of `riskText`, for the dialog that leads each reaction with its own glyph. */
export const riskHeading = (lang: AppLanguage): string =>
  t(lang, '볼에서 나오면', 'If it breaks free', 'ボールから出たら', 'Si se libera')

export const riskFlee = (lang: AppLanguage, flee: string): string =>
  t(lang, `도망 ${flee}`, `flee ${flee}`, `にげる ${flee}`, `huida ${flee}`)

export const riskAttack = (lang: AppLanguage, attack: string): string =>
  t(lang, `공격 ${attack}`, `attack ${attack}`, `こうげき ${attack}`, `ataque ${attack}`)

/** The Razz Berry's status chip on the wild plate. */
export function primedBadge(lang: AppLanguage): string {
  return t(lang, '라즈열매', 'Razz', 'ズリのみ', 'Frambu')
}

/** The stolen-tokens status chip: the amount, as a loss. */
export function stolenBadge(lang: AppLanguage, amount: string): string {
  return t(lang, `−${amount}`, `−${amount}`, `−${amount}`, `−${amount}`)
}

/** Behind the one on stage: a count, short enough for a menu cell. */
export function moreWaitingText(lang: AppLanguage, count: number): string {
  return t(lang, `+${count} 대기 중`, `+${count} waiting`, `+${count}匹 まち`, `+${count} esperando`)
}

export function primedText(lang: AppLanguage): string {
  return t(
    lang,
    '라즈열매: 다음 볼이 잘 잡혀요',
    'Razz Berry: your next ball catches more easily',
    'ズリのみ：次のボールでつかまえやすい',
    'Baya Frambu: tu próxima ball captura mejor',
  )
}

export function stolenText(lang: AppLanguage, amount: string): string {
  return t(
    lang,
    `토큰 ${amount}을(를) 가져갔어요 — 잡으면 돌려받아요`,
    `Has taken ${amount} tokens — catch it to get them back`,
    `トークンを${amount}とった — つかまえれば取り返せる`,
    `Se ha llevado ${amount} tokens — captúralo para recuperarlos`,
  )
}

/** Shown in the bag: berries are not used from there. */
export function berryBagHint(lang: AppLanguage): string {
  return t(
    lang,
    '야생 포켓몬을 만났을 때 사용해요.',
    'Use it during a wild encounter.',
    '野生のポケモンに出会ったときに使います。',
    'Úsala durante un encuentro salvaje.',
  )
}

/** The finds strip's heading: items lying in the wild area. */
export function findsText(lang: AppLanguage, count: number): string {
  return t(
    lang,
    `아이템 ${count}개를 발견했어요`,
    count === 1 ? 'An item turned up' : `${count} items turned up`,
    `アイテムを${count}個見つけた`,
    count === 1 ? 'Has encontrado un objeto' : `Has encontrado ${count} objetos`,
  )
}

export function collectLabel(lang: AppLanguage, itemName: string): string {
  return t(lang, `${itemName} 줍기`, `Pick up ${itemName}`, `${itemName}をひろう`, `Recoger ${itemName}`)
}

export function collectAllLabel(lang: AppLanguage): string {
  return t(lang, '모두 줍기', 'Pick up all', 'ぜんぶひろう', 'Recoger todo')
}

export function trailTitle(lang: AppLanguage): string {
  return t(lang, '전설의 흔적', 'Legendary trail', 'でんせつの あしあと', 'Rastro legendario')
}

/** How long a trail stays warm. `hours` is rounded up so "0 h" never shows while it is still there. */
export function trailExpiresText(lang: AppLanguage, hours: number): string {
  return timeLeftText(lang, hours)
}

/**
 * How long is left, the one way the game says it: hours under a day, days and hours past it
 * ("2 d 19 h left"), lower case because it follows a name after "·". Rounded up to the hour.
 */
export function timeLeftText(lang: AppLanguage, hours: number): string {
  const total = Math.max(1, Math.ceil(hours))
  const days = Math.floor(total / 24)
  const h = total % 24
  const span = (d: string, hr: string) =>
    days === 0 ? `${h} ${hr}` : h === 0 ? `${days} ${d}` : `${days} ${d} ${h} ${hr}`
  return t(
    lang,
    `${span('일', '시간')} 남음`,
    `${span('d', 'h')} left`,
    `のこり ${span('日', '時間')}`,
    `quedan ${span('d', 'h')}`,
  )
}

export function trackLabel(lang: AppLanguage, price: string): string {
  return t(lang, `추적 · ${price}`, `Track · ${price}`, `追跡 · ${price}`, `Rastrear · ${price}`)
}

export function trackConfirmLabel(lang: AppLanguage): string {
  return t(lang, '추적하기', 'Track it', '追跡する', 'Rastrear')
}

export function trackConfirmTitle(lang: AppLanguage, name: string): string {
  return t(
    lang,
    `${name}을(를) 다시 찾아갈까요?`,
    `Track down ${name} again?`,
    `${name}をもう一度さがしますか？`,
    `¿Rastrear de nuevo a ${name}?`,
  )
}

export function trackNoRoomText(lang: AppLanguage): string {
  return t(
    lang,
    '야생 구역이 가득 찼어요 — 먼저 자리를 만들어 주세요.',
    'Your wild area is full — make some room first.',
    '野生エリアがいっぱいです — 先に空きを作りましょう。',
    'Tu zona salvaje está llena — haz hueco primero.',
  )
}

export function trackCantAffordText(lang: AppLanguage): string {
  return t(
    lang,
    '토큰이 부족해요.',
    'Not enough tokens.',
    'トークンが足りません。',
    'No tienes suficientes tokens.',
  )
}

export function trackExpiredText(lang: AppLanguage): string {
  return t(
    lang,
    '발자국이 사라져 버렸어요.',
    'The trail has gone cold.',
    '足あとが消えてしまった。',
    'El rastro se ha enfriado.',
  )
}

// MARK: - Save import

/** The import dialog's headline: where the save comes from, when, and how much it holds. */
export function importSourceText(
  lang: AppLanguage,
  device: string | undefined,
  exportedAt: number,
  dexCount: number,
): string {
  // A calendar date, written the same way in every language: the export stamp is a fact to
  // compare against, not prose.
  const date = exportedAt > 0 ? new Date(exportedAt).toISOString().slice(0, 10) : undefined
  const from = device === undefined || device === '' ? undefined : `"${device}"`
  if (from === undefined) {
    return t(
      lang,
      `다른 기기의 세이브예요${date === undefined ? '' : ` (${date})`}. 도감 ${dexCount}마리.`,
      `This save comes from another device${date === undefined ? '' : `, exported ${date}`}, with ${dexCount} in the Pokédex.`,
      `ほかの端末のセーブです${date === undefined ? '' : `（${date}）`}。図鑑は${dexCount}匹。`,
      `Esta partida viene de otro dispositivo${date === undefined ? '' : `, exportada el ${date}`}, con ${dexCount} en la Pokédex.`,
    )
  }
  return t(
    lang,
    `${from}의 세이브예요${date === undefined ? '' : ` (${date})`}. 도감 ${dexCount}마리.`,
    `This save comes from ${from}${date === undefined ? '' : `, exported ${date}`}, with ${dexCount} in the Pokédex.`,
    `${from}のセーブです${date === undefined ? '' : `（${date}）`}。図鑑は${dexCount}匹。`,
    `Esta partida viene de ${from}${date === undefined ? '' : `, exportada el ${date}`}, con ${dexCount} en la Pokédex.`,
  )
}

/** What Merge and Replace each do, and what stays on this device either way. */
export function importChoiceDetail(lang: AppLanguage): string {
  return t(
    lang,
    '합치기: 두 도감과 두 기기의 사용량을 모두 지켜요. 동료, 가방, 잔액은 더 진행된 세이브를 따라가요. ' +
      '바꾸기: 이 기기의 진행을 세이브의 것으로 바꿔요.\n\n어느 쪽이든 오늘의 사용량과 표시 언어는 이 기기의 것을 그대로 두고, 먼저 백업을 저장해요.',
    "Merge keeps both Pokédexes and all the usage either device counted; the companion, bag and balance continue from whichever save has progressed more. Replace discards this device's progress for the save's.\n\nEither way, today's usage counter and the display language stay as they are on this device, and a backup of your current state is saved first.",
    '合わせる：両方の図鑑と、両方の端末で数えた使用量をすべて残します。相棒・バッグ・残高は、より進んだセーブから続きます。' +
      '置きかえる：この端末の進行をセーブのものに置きかえます。\n\nどちらでも、今日の使用量と表示言語はこの端末のままで、先にバックアップを保存します。',
    'Combinar conserva las dos Pokédex y todo el uso que contó cada dispositivo; el compañero, la bolsa y el saldo siguen desde la partida que haya avanzado más. Reemplazar descarta el progreso de este dispositivo por el de la partida.\n\nEn ambos casos, el uso de hoy y el idioma se quedan como están en este dispositivo, y antes se guarda una copia de seguridad.',
  )
}

export function importMergeLabel(lang: AppLanguage): string {
  return t(lang, '합치기', 'Merge', '合わせる', 'Combinar')
}

export function importReplaceLabel(lang: AppLanguage): string {
  return t(lang, '바꾸기', 'Replace', '置きかえる', 'Reemplazar')
}

export function importedText(lang: AppLanguage): string {
  return t(
    lang,
    '세이브를 불러왔어요.',
    'Save imported.',
    'セーブを読みこみました。',
    'Partida importada.',
  )
}

/** After a merge: what was gained, and whose companion carries on. */
export function mergedText(lang: AppLanguage, dexAdded: number, narrative: 'local' | 'remote'): string {
  return narrative === 'local'
    ? t(
        lang,
        `세이브를 합쳤어요: 도감 ${dexAdded}마리 추가. 이 기기의 동료가 계속해요.`,
        `Saves merged: ${dexAdded} new in the Pokédex. Your companion here continues.`,
        `セーブを合わせました：図鑑に${dexAdded}匹追加。この端末の相棒が続けます。`,
        `Partidas combinadas: ${dexAdded} nuevos en la Pokédex. Tu compañero de aquí continúa.`,
      )
    : t(
        lang,
        `세이브를 합쳤어요: 도감 ${dexAdded}마리 추가. 불러온 세이브의 동료가 여기서 계속해요.`,
        `Saves merged: ${dexAdded} new in the Pokédex. The companion from the imported save continues here.`,
        `セーブを合わせました：図鑑に${dexAdded}匹追加。読みこんだセーブの相棒がここで続けます。`,
        `Partidas combinadas: ${dexAdded} nuevos en la Pokédex. El compañero de la partida importada continúa aquí.`,
      )
}

// MARK: - Sync

/** The one-time consent: what leaves this machine, and where it goes (`docs/sync.md` §5). */
export function syncConsentText(lang: AppLanguage): string {
  return t(
    lang,
    'GitHub로 이 게임을 다른 컴퓨터와 동기화할까요?',
    'Sync this game with your other computers through GitHub?',
    'GitHubでこのゲームをほかのコンピューターと同期しますか？',
    '¿Sincronizar esta partida con tus otros equipos a través de GitHub?',
  )
}

export function syncConsentDetail(lang: AppLanguage): string {
  return t(
    lang,
    '내 GitHub 계정의 비공개(secret) gist에 다음을 올려요: 누적 토큰 수, 활동한 날짜, 도감, 가방. 오늘의 공급자별 사용량과 표시 언어는 올리지 않아요.\n\nsecret gist는 목록에 나오지 않지만 URL을 아는 사람은 읽을 수 있어요. 동기화는 이 컴퓨터에서만 켜지고, 다른 컴퓨터에서도 한 번씩 켜야 해요.',
    "A secret gist in your GitHub account will hold: your lifetime token totals, the days you were active, your Pokédex and your bag. Today's per-provider usage and the display language are not uploaded.\n\nA secret gist is unlisted, but anyone with its URL can read it. Sync is turned on for this computer only; turn it on once on each of the others.",
    'あなたのGitHubアカウントのシークレットgistに、累計トークン数・活動した日・図鑑・バッグを保存します。今日のプロバイダー別使用量と表示言語はアップロードしません。\n\nシークレットgistは一覧に出ませんが、URLを知っている人は読めます。同期はこのコンピューターだけで有効になります。ほかのコンピューターでも一度ずつ有効にしてください。',
    'Un gist secreto de tu cuenta de GitHub guardará: tus tokens totales, los días con actividad, tu Pokédex y tu bolsa. El uso de hoy por proveedor y el idioma no se suben.\n\nUn gist secreto no aparece en listados, pero cualquiera con su URL puede leerlo. La sincronización se activa solo en este equipo; actívala una vez en cada uno de los demás.',
  )
}

export function syncEnableLabel(lang: AppLanguage): string {
  return t(lang, '동기화 켜기', 'Turn on sync', '同期を有効にする', 'Activar sincronización')
}

/**
 * The first-sync question (`docs/sync.md` §7.1): both machines have a game, only one companion can
 * continue. Names both sides concretely, and says the Pokédexes merge either way — otherwise the
 * choice reads as "delete one of my collections".
 */
export function syncChoiceText(
  lang: AppLanguage,
  local: { dexCount: number; tokens: number },
  remote: { label: string; dexCount: number; tokens: number },
): string {
  const lt = compact(local.tokens)
  const rt = compact(remote.tokens)
  return t(
    lang,
    `두 컴퓨터에 각각 게임이 있어요. 이 컴퓨터: 도감 ${local.dexCount}마리, ${lt} 토큰. ${remote.label}: 도감 ${remote.dexCount}마리, ${rt} 토큰. 어느 동료가 계속할까요?`,
    `Both computers have a game. This one: ${local.dexCount} in the Pokédex, ${lt} tokens. ${remote.label}: ${remote.dexCount} in the Pokédex, ${rt} tokens. Which companion continues?`,
    `両方のコンピューターにゲームがあります。このコンピューター：図鑑${local.dexCount}匹、${lt}トークン。${remote.label}：図鑑${remote.dexCount}匹、${rt}トークン。どちらの相棒が続けますか？`,
    `Los dos equipos tienen partida. Este: ${local.dexCount} en la Pokédex, ${lt} tokens. ${remote.label}: ${remote.dexCount} en la Pokédex, ${rt} tokens. ¿Qué compañero continúa?`,
  )
}

export function syncChoiceDetail(lang: AppLanguage): string {
  return t(
    lang,
    '어느 쪽을 골라도 두 도감과 두 컴퓨터의 사용량은 모두 지켜요. 고르지 않은 쪽의 동료, 알, 가방, 잔액은 백업으로 저장돼요.',
    "Whichever you pick, both Pokédexes and all the usage either computer counted are kept. The other side's companion, egg, bag and balance are saved to a backup.",
    'どちらを選んでも、両方の図鑑と両方のコンピューターの使用量はすべて残ります。選ばなかった側の相棒・タマゴ・バッグ・残高はバックアップに保存されます。',
    'Elijas el que elijas, se conservan las dos Pokédex y todo el uso que contó cada equipo. El compañero, el huevo, la bolsa y el saldo del otro lado se guardan en una copia de seguridad.',
  )
}

export function syncKeepLocalLabel(lang: AppLanguage): string {
  return t(
    lang,
    '이 컴퓨터의 동료',
    "This computer's companion",
    'このコンピューターの相棒',
    'El de este equipo',
  )
}

export function syncKeepRemoteLabel(lang: AppLanguage, label: string): string {
  return t(lang, `${label}의 동료`, `${label}'s companion`, `${label}の相棒`, `El de ${label}`)
}

export function syncDoneText(lang: AppLanguage, dexAdded: number, devices: number): string {
  return dexAdded > 0
    ? t(
        lang,
        `동기화했어요: 도감 ${dexAdded}마리 추가 (다른 컴퓨터 ${devices}대).`,
        `Synced: ${dexAdded} new in the Pokédex (${devices} other computer${devices === 1 ? '' : 's'}).`,
        `同期しました：図鑑に${dexAdded}匹追加（ほかのコンピューター${devices}台）。`,
        `Sincronizado: ${dexAdded} nuevos en la Pokédex (${devices} equipo${devices === 1 ? '' : 's'} más).`,
      )
    : t(
        lang,
        `동기화했어요 (다른 컴퓨터 ${devices}대).`,
        `Synced (${devices} other computer${devices === 1 ? '' : 's'}).`,
        `同期しました（ほかのコンピューター${devices}台）。`,
        `Sincronizado (${devices} equipo${devices === 1 ? '' : 's'} más).`,
      )
}

/** A fork went to another computer: this one's recent companion progress was replaced. */
export function syncContinuedFromText(lang: AppLanguage, label: string): string {
  return t(
    lang,
    `${label}의 게임이 여기서 계속돼요. 도감과 사용량은 합쳐졌고, 이 컴퓨터의 이전 상태는 백업으로 저장했어요.`,
    `The game from ${label} continues here. Pokédexes and usage were merged; this computer's previous state was saved to a backup.`,
    `${label}のゲームがここで続きます。図鑑と使用量は合わせました。このコンピューターの以前の状態はバックアップに保存しました。`,
    `Aquí continúa la partida de ${label}. Las Pokédex y el uso se combinaron; el estado anterior de este equipo se guardó en una copia de seguridad.`,
  )
}

export function syncNewerPeerText(lang: AppLanguage): string {
  return t(
    lang,
    '다른 컴퓨터가 더 새로운 Tokendex를 쓰고 있어서 그 게임을 읽을 수 없어요. 확장을 업데이트하세요.',
    'Another computer runs a newer Tokendex, so its game cannot be read here. Update the extension.',
    'ほかのコンピューターがより新しいTokendexを使っているため、そのゲームを読めません。拡張機能を更新してください。',
    'Otro equipo usa un Tokendex más nuevo y su partida no se puede leer aquí. Actualiza la extensión.',
  )
}

export function syncDisabledText(lang: AppLanguage): string {
  return t(
    lang,
    '이 컴퓨터의 동기화를 껐어요. 게임은 이 컴퓨터에 그대로 있고, gist도 지우지 않았어요.',
    'Sync is off on this computer. Your game stays here, and the gist was not deleted.',
    'このコンピューターの同期を無効にしました。ゲームはここに残り、gistは削除していません。',
    'Sincronización desactivada en este equipo. Tu partida se queda aquí y el gist no se ha borrado.',
  )
}

/** Turning sync on did not go through: nothing was changed, and nothing will retry on its own. */
export function syncNotTurnedOnText(lang: AppLanguage): string {
  return t(
    lang,
    '동기화를 켜지 못했어요: GitHub에 연결할 수 없었어요. 게임은 그대로예요. 명령 팔레트에서 다시 시도하세요.',
    'Sync was not turned on: GitHub could not be reached. Your game is unchanged. Try again from the command palette.',
    '同期を有効にできませんでした：GitHubに接続できませんでした。ゲームはそのままです。コマンドパレットからもう一度お試しください。',
    'No se activó la sincronización: no se pudo conectar con GitHub. Tu partida no ha cambiado. Inténtalo de nuevo desde la paleta de comandos.',
  )
}

export function syncFailedText(lang: AppLanguage, reason: string): string {
  switch (reason) {
    // 'off': the worker holds no credential — there is no GitHub session with the gist scope.
    case 'off':
    case 'auth':
      return t(
        lang,
        'GitHub가 동기화 권한을 거부했어요. 다시 로그인하세요.',
        'GitHub refused the sync credential. Sign in again.',
        'GitHubが同期の認証を拒否しました。もう一度サインインしてください。',
        'GitHub rechazó la credencial de sincronización. Vuelve a iniciar sesión.',
      )
    case 'rateLimited':
      return t(
        lang,
        'GitHub 요청 한도에 걸렸어요. 잠시 후 다시 동기화해요.',
        'GitHub rate limit reached. Sync will retry later.',
        'GitHubのリクエスト上限に達しました。しばらくして再試行します。',
        'Se alcanzó el límite de GitHub. La sincronización lo reintentará más tarde.',
      )
    case 'tooLarge':
      return t(
        lang,
        '게임이 너무 커서 gist에 올릴 수 없어요.',
        'The game is too large for a gist.',
        'ゲームが大きすぎてgistに保存できません。',
        'La partida es demasiado grande para un gist.',
      )
    default:
      return t(
        lang,
        '지금은 동기화할 수 없어요. 나중에 다시 시도해요.',
        'Could not sync right now. It will retry later.',
        '今は同期できません。あとで再試行します。',
        'No se pudo sincronizar ahora. Se reintentará más tarde.',
      )
  }
}

export function syncSignInLabel(lang: AppLanguage): string {
  return t(lang, '로그인', 'Sign in', 'サインイン', 'Iniciar sesión')
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
  | { kind: 'evolved'; name: string; registered?: string }
  | { kind: 'graduated'; name: string }
  | { kind: 'companionChosen'; name: string }
  | { kind: 'companionSwitched'; from: string; to?: string }
  | { kind: 'shinyRegistered'; name: string }
  | { kind: 'medalEarned'; medalID: string }
  | { kind: 'challengeDone'; challenge: Challenge }
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
  | { kind: 'wildQueueFull'; count: number }

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
        `${event.name} registered in the Pokédex!`,
        `${event.name}がずかんにとうろくされた！`,
        `¡${event.name} registrado en la Pokédex!`,
      )
    case 'challengeDone':
      return t(
        lang,
        `✅ 도전 완료: ${challengeText(lang, event.challenge)} (토큰 +${compact(challengeReward(event.challenge))})`,
        `✅ Challenge done: ${challengeText(lang, event.challenge)} (+${compact(challengeReward(event.challenge))} tokens)`,
        `✅ チャレンジ たっせい: ${challengeText(lang, event.challenge)} (トークン +${compact(challengeReward(event.challenge))})`,
        `✅ Reto cumplido: ${challengeText(lang, event.challenge)} (+${compact(challengeReward(event.challenge))} tokens)`,
      )
    case 'medalEarned':
      return t(
        lang,
        `🏅 메달 획득: ${medalName(lang, event.medalID)}`,
        `🏅 Medal earned: ${medalName(lang, event.medalID)}`,
        `🏅 メダル かくとく: ${medalName(lang, event.medalID)}`,
        `🏅 Medalla conseguida: ${medalName(lang, event.medalID)}`,
      )
    case 'shinyRegistered':
      return t(
        lang,
        `✨ ${event.name}의 색이 다른 모습이 도감에 등록되었어요!`,
        `✨ Shiny ${event.name} registered in the Pokédex!`,
        `✨ いろちがいの ${event.name}が ずかんに とうろくされた!`,
        `✨ ¡${event.name} shiny registrado en la Pokédex!`,
      )
    case 'companionChosen':
      return t(
        lang,
        `이제 ${event.name}이(가) 함께해요!`,
        `${event.name} joins you now!`,
        `${event.name}が いっしょに いる!`,
        `¡Ahora te acompaña ${event.name}!`,
      )
    case 'companionSwitched':
      return event.to === undefined
        ? t(
            lang,
            `${event.from}의 도감이 완성됐어요. 이제 알을 품어요.`,
            `${event.from} is fully registered. An egg takes the stage.`,
            `${event.from}のとうろくがかんりょう。つぎはタマゴをあたためよう。`,
            `${event.from} está registrado del todo. Ahora toca incubar un huevo.`,
          )
        : t(
            lang,
            `${event.from}의 도감이 완성됐어요. 이제 ${event.to}이(가) 함께해요.`,
            `${event.from} is fully registered. ${event.to} joins you now.`,
            `${event.from}のとうろくがかんりょう。こんどは${event.to}がいっしょだ。`,
            `${event.from} está registrado del todo. Ahora te acompaña ${event.to}.`,
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
        `¡Ha aparecido un ${event.name} salvaje!`,
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
    // Says what stopped and what restarts it: the user did nothing wrong, the area just filled.
    case 'wildQueueFull':
      return t(
        lang,
        `야생 구역이 가득 찼어요 (${event.count}). 자리가 생길 때까지 새로운 만남이 멈춰요.`,
        `Your wild area is full (${event.count}). New encounters are paused until you make room.`,
        `野生エリアがいっぱいです（${event.count}）。空きができるまで新しい出会いは止まります。`,
        `Tu zona salvaje está llena (${event.count}). Los nuevos encuentros se pausan hasta que hagas hueco.`,
      )
  }
}

/** The celebration toast's single button. */
export function openPanelLabel(lang: AppLanguage): string {
  return statusOpenPanel(lang) // the tooltip link's words: one "open panel" in the whole app
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

// MARK: - Companion choice, starters and the egg stock (phase 2)

/** A label with its count, the way the Pokédex segments show it: "Collection (8)". */
export function countedLabel(label: string, count: number): string {
  return `${label} (${count})`
}

/** The Pokédex completion line: "5 / 649". */
export function dexProgressText(done: number | string, total: number | string): string {
  return `${done} / ${total}`
}

/** A species' registration line in the Pokédex: "45% registered", or "Registered" once full. */
export function registrationText(lang: AppLanguage, percent: number, registered: boolean): string {
  if (registered) return t(lang, '등록 완료', 'Registered', 'とうろくずみ', 'Registrado')
  return t(
    lang,
    `${percent}% 등록`,
    `${percent}% registered`,
    `${percent}% とうろく`,
    `${percent}% registrado`,
  )
}

/** The egg stock: "2 eggs in stock". */
export function eggStockText(lang: AppLanguage, count: number): string {
  return t(
    lang,
    `알 ${count}개 보유`,
    count === 1 ? '1 egg in stock' : `${count} eggs in stock`,
    `タマゴ ${count}こ`,
    count === 1 ? '1 huevo en reserva' : `${count} huevos en reserva`,
  )
}

/** The button that starts incubating an egg from the stock. */
export const incubateEggText = (lang: AppLanguage): string =>
  t(lang, '알 부화시키기', 'Incubate an egg', 'タマゴをあたためる', 'Incubar un huevo')

/** The same button when an egg was set aside for a companion and is waiting. */
export const resumeEggText = (lang: AppLanguage): string =>
  t(lang, '알 이어서 부화시키기', 'Resume the egg', 'タマゴのつづきをあたためる', 'Retomar el huevo')

/** The Pokédex detail's button that makes an unlocked species the companion. */
export const chooseCompanionText = (lang: AppLanguage): string =>
  t(lang, '컴패니언으로 선택', 'Choose as companion', 'コンパニオンにする', 'Elegir como compañero')

/** Badge on the species that is the companion right now. */
export const companionBadgeText = (lang: AppLanguage): string =>
  t(lang, '내 컴패니언', 'Your companion', 'あなたのコンパニオン', 'Tu compañero')

/** The first-run screen's title. */
export const starterTitleText = (lang: AppLanguage): string =>
  t(
    lang,
    '첫 포켓몬을 골라요',
    'Choose your first Pokémon',
    'さいしょのポケモンをえらぼう',
    'Elige tu primer Pokémon',
  )

/** The first-run screen's line under the title. */
export const starterPromptText = (lang: AppLanguage): string =>
  t(
    lang,
    '컴패니언이 되어 사용하는 토큰마다 함께 성장해요.',
    'It becomes your companion, and every token you spend helps it grow.',
    'コンパニオンになり、つかったトークンでそだちます。',
    'Será tu compañero, y cada token que gastes lo hará crecer.',
  )

/** The companion could not be rebuilt: its evolution line needs the network. */
export function companionOfflineText(lang: AppLanguage): string {
  return t(
    lang,
    '지금은 오프라인이라 이 포켓몬을 데려올 수 없어요. 잠시 후 다시 시도하세요.',
    'This Pokémon cannot join you offline. Try again in a moment.',
    'オフラインではこのポケモンを連れてこられません。しばらくしてからもう一度。',
    'Sin conexión no se puede traer a este Pokémon. Inténtalo en un momento.',
  )
}

/** The species is not unlocked (or the starter screen is over). */
export function companionLockedText(lang: AppLanguage): string {
  return t(
    lang,
    '아직 얻지 못한 포켓몬이에요.',
    'You have not obtained that Pokémon yet.',
    'まだ手に入れていないポケモンです。',
    'Todavía no has conseguido ese Pokémon.',
  )
}

/** Nothing to incubate: the stock is empty and no egg is paused. */
export function noEggsText(lang: AppLanguage): string {
  return t(
    lang,
    '알이 없어요. 하루에 하나씩 생겨요.',
    'No eggs to incubate. One arrives each day you work.',
    'タマゴがありません。作業した日に1つ手に入ります。',
    'No hay huevos que incubar. Cada día de trabajo llega uno.',
  )
}

// MARK: - Catching registers (phase 3)

/** A first catch: how far the species' registration reads now. */
export function caughtRegisteredText(lang: AppLanguage, percent: number): string {
  return t(
    lang,
    `도감 등록 ${percent}%!`,
    `${percent}% registered!`,
    `ずかん登録 ${percent}%!`,
    `¡${percent}% registrado!`,
  )
}

/** A duplicate catch: the species was already obtained, so it pays tokens instead. */
export function duplicateRewardText(lang: AppLanguage, amount: string): string {
  return t(
    lang,
    `이미 가진 포켓몬이라 토큰 +${amount}.`,
    `Already had it: +${amount} tokens.`,
    `もう持っているのでトークン+${amount}。`,
    `Ya lo tenías: +${amount} tokens.`,
  )
}

/** The EXP bar's figure: what it has of what the stage costs, both already compact. */
export function expProgressText(done: string, total: string): string {
  return `${done} / ${total}`
}

/** What is left to the next stage (or the hatch), beside the EXP bar. */
export function expLeftText(lang: AppLanguage, amount: string): string {
  return t(lang, `${amount} 남음`, `${amount} to go`, `あと${amount}`, `faltan ${amount}`)
}

/** Tooltip of the Poké Ball on a wild plate: the species is already obtained. */
export function ownedText(lang: AppLanguage): string {
  return t(lang, '이미 가진 포켓몬', 'Already obtained', 'つかまえたことがある', 'Ya lo tienes')
}

/** A catch's banner headline: the species is new to the Pokédex. */
export function newInDexText(lang: AppLanguage): string {
  return t(
    lang,
    '도감에 새로 등록!',
    'New in the Pokédex!',
    'ずかんに あたらしく とうろく!',
    '¡Nuevo en la Pokédex!',
  )
}

/** A catch's banner headline: a duplicate. */
export function alreadyOwnedText(lang: AppLanguage): string {
  return t(lang, '이미 가진 포켓몬', 'Already had it', 'もう もっている', 'Ya lo tenías')
}

/** A catch's banner detail: the registration share it added. */
export function catchShareText(lang: AppLanguage, percent: number): string {
  return t(
    lang,
    `등록 +${percent}%`,
    `+${percent}% registered`,
    `とうろく +${percent}%`,
    `+${percent}% registrado`,
  )
}

/** A catch's banner detail: the tokens a duplicate paid. */
export function rewardTokensText(lang: AppLanguage, amount: string): string {
  return t(lang, `토큰 +${amount}`, `+${amount} tokens`, `トークン +${amount}`, `+${amount} tokens`)
}

/** The scene's banner for a catch, or nothing for any other turn. */
export function catchNews(
  lang: AppLanguage,
  outcome: Omit<Extract<TurnOutcome, { kind: 'caught' }>, 'shakes'>,
): { isNew: boolean; headline: string; detail: string } {
  if (outcome.reward !== undefined) {
    return {
      isNew: false,
      headline: alreadyOwnedText(lang),
      detail: rewardTokensText(lang, compact(outcome.reward)),
    }
  }
  return {
    isNew: true,
    headline: newInDexText(lang),
    detail: catchShareText(lang, outcome.registeredPercent ?? 0),
  }
}

/** Settings: the finished-companion toggle. */
export function keepCompletedLabel(lang: AppLanguage): string {
  return t(
    lang,
    '등록을 마친 포켓몬과 계속 함께하기',
    'Keep a fully registered companion',
    'とうろくを おえた ポケモンと いっしょに いる',
    'Mantener al compañero registrado del todo',
  )
}

/** Settings: what the toggle changes, under it. */
export function keepCompletedHint(lang: AppLanguage): string {
  return t(
    lang,
    '끄면 마지막 진화의 막대가 가득 찼을 때 아직 등록하지 않은 포켓몬으로 바뀌어요. 켜면 그대로 남고 토큰은 색이 다른 모습을 위해 모여요.',
    'Off: when its last form’s bar is full, it switches to one of yours still unregistered. On: it stays, and its tokens wait for the shiny.',
    'オフ: さいごの しんかの バーが いっぱいに なると、まだ とうろくしていない ポケモンに かわる。オン: そのまま のこり、トークンは いろちがいの ために たまる。',
    'Desactivado: cuando su última forma llena la barra, cambia a uno tuyo aún sin registrar. Activado: se queda, y sus tokens esperan al shiny.',
  )
}

// MARK: - The shiny bar (phase 5)

/** A registered species' shiny bar: "Shiny 12% · 192M / 1.6B". */
export function shinyBarText(lang: AppLanguage, percent: number, done: string, total: string): string {
  return t(
    lang,
    `색이 다른 모습 ${percent}% · ${done} / ${total}`,
    `Shiny ${percent}% · ${done} / ${total}`,
    `いろちがい ${percent}% · ${done} / ${total}`,
    `Shiny ${percent}% · ${done} / ${total}`,
  )
}

/** The shiny bar once full. */
export function shinyRegisteredText(lang: AppLanguage): string {
  return t(
    lang,
    '색이 다른 모습 등록 완료',
    'Shiny registered',
    'いろちがい とうろくずみ',
    'Shiny registrado',
  )
}

/** A boost button's accessible name. */
export function shinyBoostLabel(lang: AppLanguage, name: string, amount: string): string {
  return t(
    lang,
    `${name}의 색이 다른 모습에 토큰 ${amount} 쓰기`,
    `Boost shiny ${name} by ${amount} tokens`,
    `いろちがいの ${name}に トークン${amount}を つかう`,
    `Impulsar ${name} shiny con ${amount} tokens`,
  )
}

/** A boost's native confirmation title: "Shiny Charizard". */
export function shinyBoostTitle(lang: AppLanguage, name: string): string {
  return t(lang, `색이 다른 ${name}`, `Shiny ${name}`, `いろちがいの ${name}`, `${name} shiny`)
}

/** Nothing to buy: the wallet is empty. */
export function shinyBoostNoFundsText(lang: AppLanguage): string {
  return trackCantAffordText(lang) // one sentence for one fact, wherever the wallet is short
}

/** Nothing to buy: the boost cap (`percent` of the bar) was bought, the rest is played. */
export function shinyBoostCappedText(lang: AppLanguage, percent: number): string {
  return t(
    lang,
    `막대의 ${percent}%까지 샀어요. 나머지는 함께하며 채워요.`,
    `${percent}% of the bar was bought; the rest is earned as your companion.`,
    `バーの ${percent}%まで かった。のこりは いっしょに ためよう。`,
    `Ya compraste el ${percent}% de la barra; el resto se gana como compañero.`,
  )
}

/** The Shinydex segment's label. */
export function shinydexLabel(lang: AppLanguage): string {
  return t(lang, '색이 다른 도감', 'Shinydex', 'いろちがいずかん', 'Shinydex')
}

/** A boost that no longer fits: the wallet moved, or another window bought first. */
export function shinyBoostFailedText(lang: AppLanguage): string {
  return t(
    lang,
    '지금은 그만큼 쓸 수 없어요. 다시 확인해 주세요.',
    'That boost no longer fits. Nothing was charged.',
    'いまは それだけ つかえない。なにも はらっていない。',
    'Ese impulso ya no cabe. No se ha cobrado nada.',
  )
}

// MARK: - The lure (phase 6)

/** The lure button: "Lure · 24 h". */
export function lureButtonText(lang: AppLanguage, hours: number): string {
  return t(
    lang,
    `유인 · ${hours}시간`,
    `Lure · ${hours} h`,
    `おびきよせ · ${hours}じかん`,
    `Atraer · ${hours} h`,
  )
}

/** The lure button's accessible name. */
export function lureLabel(lang: AppLanguage, name: string, hours: number, price: string): string {
  return t(
    lang,
    `${name}을(를) ${hours}시간 유인하기, 토큰 ${price}`,
    `Lure ${name} for ${hours} hours, ${price} tokens`,
    `${name}を ${hours}じかん おびきよせる、トークン${price}`,
    `Atraer a ${name} durante ${hours} horas, ${price} tokens`,
  )
}

/** The lure's native confirmation title; says so when it replaces the lure running. */
export function lureConfirmTitle(lang: AppLanguage, name: string, replaces: boolean): string {
  const base = t(lang, `${name} 유인`, `Lure ${name}`, `${name}を おびきよせる`, `Atraer a ${name}`)
  if (!replaces) return base
  return `${base} ${t(
    lang,
    '(지금 유인을 대신해요)',
    '(replaces the lure running)',
    '(いまの おびきよせと いれかわる)',
    '(sustituye a la atracción activa)',
  )}`
}

/** The lure running, on Home: "Luring Charmander · 5 h left". */
export function lureActiveText(lang: AppLanguage, name: string, hoursLeft: number): string {
  const luring = t(
    lang,
    `${name} 유인 중`,
    `Luring ${name}`,
    `${name}を おびきよせ中`,
    `Atrayendo a ${name}`,
  )
  return `${luring} · ${timeLeftText(lang, hoursLeft)}`
}

/** A lure that no longer fits: the wallet moved, or the species was obtained meanwhile. */
export function lureFailedText(lang: AppLanguage): string {
  return t(
    lang,
    '지금은 유인할 수 없어요. 아무것도 쓰지 않았어요.',
    'That lure no longer fits. Nothing was charged.',
    'いまは おびきよせられない。なにも はらっていない。',
    'Ya no puedes atraerlo. No se ha cobrado nada.',
  )
}

// MARK: - Medals and regions (phase 7)

/** A region's name, as each language's games call it. */
export function regionName(lang: AppLanguage, region: RegionID): string {
  switch (region) {
    case 'kanto':
      return t(lang, '관동', 'Kanto', 'カントー', 'Kanto')
    case 'johto':
      return t(lang, '성도', 'Johto', 'ジョウト', 'Johto')
    case 'hoenn':
      return t(lang, '호연', 'Hoenn', 'ホウエン', 'Hoenn')
    case 'sinnoh':
      return t(lang, '신오', 'Sinnoh', 'シンオウ', 'Sinnoh')
    case 'unova':
      return t(lang, '하나', 'Unova', 'イッシュ', 'Teselia')
  }
}

/** A medal's name, from its id (`medals.ts`): the kind's title and the count it asks for. */
export function medalName(lang: AppLanguage, medalID: string): string {
  const [kind, arg] = medalID.split('-') as [string, string | undefined]
  switch (kind) {
    case 'registered':
      return t(
        lang,
        `연구원 · ${arg}`,
        `Researcher · ${arg}`,
        `けんきゅういん · ${arg}`,
        `Investigador · ${arg}`,
      )
    case 'shiny':
      return t(
        lang,
        `빛나는 수집가 · ${arg}`,
        `Shiny collector · ${arg}`,
        `いろちがい コレクター · ${arg}`,
        `Coleccionista shiny · ${arg}`,
      )
    case 'caught':
      return t(
        lang,
        `포획왕 · ${arg}`,
        `Catcher · ${arg}`,
        `ほかくの たつじん · ${arg}`,
        `Capturador · ${arg}`,
      )
    case 'line':
      return t(lang, '첫 진화의 끝', 'Line complete', 'さいしょの しんかの はて', 'Línea completa')
    case 'region':
      return t(
        lang,
        `${regionName(lang, arg as RegionID)} 도감 완성`,
        `${regionName(lang, arg as RegionID)} Pokédex`,
        `${regionName(lang, arg as RegionID)} ずかん かんせい`,
        `Pokédex de ${regionName(lang, arg as RegionID)}`,
      )
    default:
      return medalID
  }
}

/** What a medal asks for, in a sentence. */
export function medalDescription(lang: AppLanguage, medalID: string): string {
  const [kind, arg] = medalID.split('-') as [string, string | undefined]
  switch (kind) {
    case 'registered':
      return arg === '1'
        ? t(lang, '한 종 등록하기', 'Register a species', '1しゅ とうろくする', 'Registra una especie')
        : t(
            lang,
            `${arg}종 등록하기`,
            `Register ${arg} species`,
            `${arg}しゅ とうろくする`,
            `Registra ${arg} especies`,
          )
    case 'shiny':
      return arg === '1'
        ? t(
            lang,
            '색이 다른 모습 한 종 등록하기',
            'Register a shiny',
            'いろちがいを 1しゅ とうろくする',
            'Registra un shiny',
          )
        : t(
            lang,
            `색이 다른 모습 ${arg}종 등록하기`,
            `Register ${arg} shinies`,
            `いろちがいを ${arg}しゅ とうろくする`,
            `Registra ${arg} shinies`,
          )
    case 'caught':
      return t(
        lang,
        `야생 포켓몬 ${arg}마리 잡기`,
        `Catch ${arg} wild Pokémon`,
        `やせいの ポケモンを ${arg}ひき つかまえる`,
        `Captura ${arg} Pokémon salvajes`,
      )
    case 'line':
      return t(
        lang,
        '진화 라인을 끝까지 키우기',
        'Raise a line to its final form',
        'しんかを さいごまで そだてる',
        'Cría una línea hasta su forma final',
      )
    case 'region':
      return t(
        lang,
        `${regionName(lang, arg as RegionID)}의 모든 종 등록하기`,
        `Register every species of ${regionName(lang, arg as RegionID)}`,
        `${regionName(lang, arg as RegionID)}の ぜんしゅを とうろくする`,
        `Registra todas las especies de ${regionName(lang, arg as RegionID)}`,
      )
    default:
      return ''
  }
}

/** The medals section heading: "Medals (4 / 23)". */
export function medalsHeading(lang: AppLanguage, earned: number, total: number): string {
  return t(
    lang,
    `메달 (${earned} / ${total})`,
    `Medals (${earned} / ${total})`,
    `メダル (${earned} / ${total})`,
    `Medallas (${earned} / ${total})`,
  )
}

// MARK: - Challenges (phase 7b)

/** A type's name, as each language's games print it. */
export function typeName(lang: AppLanguage, type: PokemonType): string {
  const names: Record<PokemonType, [string, string, string, string]> = {
    normal: ['노말', 'Normal', 'ノーマル', 'Normal'],
    fire: ['불꽃', 'Fire', 'ほのお', 'Fuego'],
    water: ['물', 'Water', 'みず', 'Agua'],
    electric: ['전기', 'Electric', 'でんき', 'Eléctrico'],
    grass: ['풀', 'Grass', 'くさ', 'Planta'],
    ice: ['얼음', 'Ice', 'こおり', 'Hielo'],
    fighting: ['격투', 'Fighting', 'かくとう', 'Lucha'],
    poison: ['독', 'Poison', 'どく', 'Veneno'],
    ground: ['땅', 'Ground', 'じめん', 'Tierra'],
    flying: ['비행', 'Flying', 'ひこう', 'Volador'],
    psychic: ['에스퍼', 'Psychic', 'エスパー', 'Psíquico'],
    bug: ['벌레', 'Bug', 'むし', 'Bicho'],
    rock: ['바위', 'Rock', 'いわ', 'Roca'],
    ghost: ['고스트', 'Ghost', 'ゴースト', 'Fantasma'],
    dragon: ['드래곤', 'Dragon', 'ドラゴン', 'Dragón'],
    dark: ['악', 'Dark', 'あく', 'Siniestro'],
    steel: ['강철', 'Steel', 'はがね', 'Acero'],
    fairy: ['페어리', 'Fairy', 'フェアリー', 'Hada'],
  }
  const [ko, en, ja, es] = names[type]
  return t(lang, ko, en, ja, es)
}

/** What a challenge asks for, in a sentence: "Catch 3 Pokémon". */
export function challengeText(lang: AppLanguage, challenge: Challenge): string {
  const n = challenge.target
  switch (challenge.kind) {
    case 'catch':
      return t(
        lang,
        `포켓몬 ${n}마리 잡기`,
        `Catch ${n} Pokémon`,
        `ポケモンを ${n}ひき つかまえる`,
        `Captura ${n} Pokémon`,
      )
    case 'catchType': {
      const type = challenge.type === undefined ? '' : typeName(lang, challenge.type)
      return n === 1
        ? t(
            lang,
            `${type} 타입 포켓몬 잡기`,
            `Catch a ${type}-type Pokémon`,
            `${type}タイプの ポケモンを つかまえる`,
            `Captura un Pokémon de tipo ${type}`,
          )
        : t(
            lang,
            `${type} 타입 포켓몬 ${n}마리 잡기`,
            `Catch ${n} ${type}-type Pokémon`,
            `${type}タイプの ポケモンを ${n}ひき つかまえる`,
            `Captura ${n} Pokémon de tipo ${type}`,
          )
    }
    case 'newSpecies':
      return n === 1
        ? t(
            lang,
            '새로운 종을 도감에 추가하기',
            'Add a new species to the Pokédex',
            'あたらしい しゅを ずかんに くわえる',
            'Añade una especie nueva a la Pokédex',
          )
        : t(
            lang,
            `새로운 종 ${n}종을 도감에 추가하기`,
            `Add ${n} new species to the Pokédex`,
            `あたらしい しゅを ${n}しゅ ずかんに くわえる`,
            `Añade ${n} especies nuevas a la Pokédex`,
          )
    case 'useTokens':
      return t(
        lang,
        `토큰 ${compact(n)} 쓰기`,
        `Use ${compact(n)} tokens`,
        `トークンを ${compact(n)} つかう`,
        `Usa ${compact(n)} tokens`,
      )
  }
}

/** The challenges board's heading. */
export function challengesHeading(lang: AppLanguage): string {
  return t(lang, '도전', 'Challenges', 'チャレンジ', 'Retos')
}

/** A challenge's period label. */
export function challengePeriodText(lang: AppLanguage, period: 'day' | 'week'): string {
  return period === 'day'
    ? t(lang, '오늘', 'Today', 'きょう', 'Hoy')
    : t(lang, '이번 주', 'This week', 'こんしゅう', 'Esta semana')
}

export { challengeReward }

// MARK: - Home's drawers (plan 08 §8)

/** A drawer's title. */
export function drawerTitle(
  lang: AppLanguage,
  id: 'incubator' | 'challenges' | 'trail' | 'wild' | 'finds' | 'streak',
): string {
  switch (id) {
    case 'incubator':
      return t(lang, '부화기', 'Incubator', 'ふか そうち', 'Incubadora')
    case 'challenges':
      return challengesHeading(lang) // the board's own heading: one name for one thing
    case 'trail':
      return t(lang, '전설의 흔적', 'Legendary trail', 'でんせつの あしあと', 'Rastro legendario')
    case 'wild':
      return t(lang, '야생', 'Wild', 'やせい', 'Salvajes')
    case 'finds':
      return t(lang, '발견한 물건', 'Finds', 'みつけた どうぐ', 'Hallazgos')
    case 'streak':
      return t(lang, '연속 기록', 'Streak', 'れんぞく きろく', 'Racha')
  }
}

/** The incubator folded: the egg on stage, one paused, or only the stock. */
export function incubatorSummary(
  lang: AppLanguage,
  egg: { percent?: number; paused?: boolean; stock: number },
): string {
  // The egg stock's own sentence, the one Home's strip uses: one fact, one wording.
  const stock = eggStockText(lang, egg.stock)
  if (egg.paused === true) {
    return `${t(lang, '알 일시정지', 'Egg paused', 'タマゴ いちじていし', 'Huevo en pausa')} · ${stock}`
  }
  if (egg.percent !== undefined) {
    return `${t(lang, `알 ${egg.percent}%`, `Egg at ${egg.percent}%`, `タマゴ ${egg.percent}%`, `Huevo al ${egg.percent}%`)} · ${stock}`
  }
  return stock
}

/** The challenges folded: "1 / 3 done". */
export function challengesSummary(lang: AppLanguage, done: number, total: number): string {
  return t(
    lang,
    `${done} / ${total} 완료`,
    `${done} / ${total} done`,
    `${done} / ${total} たっせい`,
    `${done} / ${total} cumplidos`,
  )
}

/** The trail folded: what it tracks, how long it lasts, and how many more. */
export function trailSummary(lang: AppLanguage, name: string, expires: string, more: number): string {
  const head = `${name} · ${expires}`
  return more > 0 ? `${head} · +${more}` : head
}

/** The usage folded: "Today 12.3M · Month 400M". */
export function usageSummary(lang: AppLanguage, today: string, month: string): string {
  return t(
    lang,
    `오늘 ${today} · 이번 달 ${month}`,
    `Today ${today} · This month ${month}`,
    `きょう ${today} · こんげつ ${month}`,
    `Hoy ${today} · Este mes ${month}`,
  )
}

/** The usage folded into a narrow lid: today only. */
export function usageShortText(lang: AppLanguage, today: string): string {
  return t(lang, `오늘 ${today}`, `Today ${today}`, `きょう ${today}`, `Hoy ${today}`)
}

/** The wild drawer folded with nothing waiting: "Next in 700K", short enough for 280 px. */
export function nextEncounterShort(lang: AppLanguage, amount: string): string {
  return t(
    lang,
    `다음까지 ${amount}`,
    `Next in ${amount}`,
    `つぎまで ${amount}`,
    `Siguiente en ${amount}`,
  )
}

/** The expanded lid's column headings: "Today", "This month". */
export function usageColumnLabel(lang: AppLanguage, which: 'today' | 'month'): string {
  return which === 'today'
    ? t(lang, '오늘', 'Today', 'きょう', 'Hoy')
    : t(lang, '이번 달', 'This month', 'こんげつ', 'Este mes')
}

/** The lid toggle's accessible name. */
export function lidToggleLabel(lang: AppLanguage): string {
  return t(lang, '사용량 자세히', 'Usage details', 'しようりょうの くわしく', 'Detalle de uso')
}

/** The PC box: the quick switch from the battle plate. */
export function pcBoxTitle(lang: AppLanguage): string {
  return t(lang, 'PC 박스', 'PC box', 'パソコンの ボックス', 'Caja del PC')
}

/** The PC box with nothing else to switch to. */
export function pcBoxEmptyText(lang: AppLanguage): string {
  return t(
    lang,
    '바꿀 수 있는 포켓몬이 아직 없어요. 잡거나 부화시켜 보세요.',
    'No other Pokémon to switch to yet. Catch or hatch one.',
    'まだ ほかの ポケモンが いない。つかまえるか タマゴを かえそう。',
    'Aún no tienes otro Pokémon para cambiar. Captura o eclosiona uno.',
  )
}

/** The PC box's sort options. */
export function pcSortLabel(lang: AppLanguage, sort: 'progress' | 'number' | 'rarity'): string {
  switch (sort) {
    case 'progress':
      return t(lang, '진행도', 'Progress', 'しんちょく', 'Progreso')
    case 'number':
      return t(lang, '번호', 'Number', 'ばんごう', 'Número')
    case 'rarity':
      return t(lang, '희귀도', 'Rarity', 'レアリティ', 'Rareza')
  }
}

/** The PC box's status chips (plan 9.8). */
export function pcFilterLabel(
  lang: AppLanguage,
  filter: 'unregistered' | 'registered' | 'shiny',
): string {
  switch (filter) {
    case 'unregistered':
      return t(lang, '미등록', 'Not registered', 'みとうろく', 'Sin registrar')
    case 'registered':
      return t(lang, '등록 완료', 'Registered', 'とうろくずみ', 'Registrados')
    case 'shiny':
      return t(lang, '색이 다른', 'Shiny', 'いろちがい', 'Shiny')
  }
}

/** The sort direction toggle: the order it is showing, for its accessible name and tooltip. */
export function sortDirectionLabel(lang: AppLanguage, direction: 'ascending' | 'descending'): string {
  return direction === 'ascending'
    ? t(lang, '오름차순', 'Ascending', 'しょうじゅん', 'Ascendente')
    : t(lang, '내림차순', 'Descending', 'こうじゅん', 'Descendente')
}

/** The Pokédex's filters toggle (plan 9.3): its accessible name and tooltip. */
export function dexFiltersToggleLabel(lang: AppLanguage): string {
  return t(lang, '필터', 'Filters', 'フィルター', 'Filtros')
}

/** The incubator with an empty stock: how the next egg arrives. */
export function eggsEmptyText(lang: AppLanguage): string {
  return t(
    lang,
    'AI를 사용하는 날마다 알이 하나씩 와요. 상점에서 살 수도 있어요.',
    'An egg arrives each day you use AI, or buy one in the shop.',
    'AIを つかった ひに タマゴが ひとつ とどく。ショップでも かえる。',
    'Cada día que usas IA llega un huevo, o cómpralo en la tienda.',
  )
}

// MARK: - Empty states (plan 08 §7)

/** An empty view's title and the line saying how it fills — the way out, not only the absence. */
export function emptyState(
  lang: AppLanguage,
  view: 'collection' | 'shinydex' | 'log' | 'bag' | 'balls' | 'berries' | 'items',
): { title: string; hint: string } {
  switch (view) {
    case 'collection':
      return {
        title: t(
          lang,
          '아직 포켓몬이 없어요',
          'No Pokémon yet',
          'まだ ポケモンが いない',
          'Aún no tienes Pokémon',
        ),
        hint: t(
          lang,
          '알을 부화시키거나 야생 포켓몬을 잡아 보세요.',
          'Hatch an egg or catch a wild one on Home.',
          'タマゴを かえすか、ホームで やせいの ポケモンを つかまえよう。',
          'Eclosiona un huevo o captura uno salvaje en Inicio.',
        ),
      }
    case 'shinydex':
      return {
        title: t(
          lang,
          '아직 색이 다른 포켓몬이 없어요',
          'No shinies yet',
          'まだ いろちがいが いない',
          'Aún no hay shinies',
        ),
        hint: t(
          lang,
          '등록한 포켓몬을 계속 키우면 색이 다른 막대가 차요. 색이 다른 포켓몬을 잡아도 돼요.',
          'Keep raising a registered species to fill its shiny bar, or catch a shiny.',
          'とうろくした ポケモンを そだてつづけると いろちがいの バーが たまる。いろちがいを つかまえても いい。',
          'Sigue criando una especie registrada para llenar su barra shiny, o captura un shiny.',
        ),
      }
    case 'log':
      return {
        title: t(
          lang,
          '아직 잡은 포켓몬이 없어요',
          'Nothing caught yet',
          'まだ なにも つかまえていない',
          'Aún no has capturado nada',
        ),
        hint: t(
          lang,
          'AI를 쓰는 동안 홈에 야생 포켓몬이 나타나요.',
          'Wild Pokémon turn up on Home while you use AI.',
          'AIを つかうあいだ、ホームに やせいの ポケモンが あらわれる。',
          'Los Pokémon salvajes aparecen en Inicio mientras usas IA.',
        ),
      }
    case 'bag':
      return {
        title: t(
          lang,
          '가방이 비어 있어요',
          'Your bag is empty',
          'バッグは からっぽ',
          'Tu bolsa está vacía',
        ),
        hint: t(
          lang,
          '상점에서 볼과 열매를 사거나, 야생에서 물건을 주워 보세요.',
          'Buy balls and berries in the shop, or pick up finds in the wild.',
          'ショップで ボールや きのみを かうか、やせいで どうぐを ひろおう。',
          'Compra balls y bayas en la tienda, o recoge hallazgos en estado salvaje.',
        ),
      }
    // A pocket is never disabled (plan 9.6): empty, it says how it fills, like the bag.
    case 'balls':
      return {
        title: t(lang, '볼이 없어요', 'No Poké Balls', 'ボールが ない', 'No tienes Poké Balls'),
        hint: t(
          lang,
          '상점에서 사거나, 야생에서 주워 보세요.',
          'Buy them in the shop, or pick them up in the wild.',
          'ショップで かうか、やせいで ひろおう。',
          'Cómpralas en la tienda o recógelas en estado salvaje.',
        ),
      }
    case 'berries':
      return {
        title: t(lang, '열매가 없어요', 'No berries', 'きのみが ない', 'No tienes bayas'),
        hint: t(
          lang,
          '상점에서 사거나, 야생에서 주워 보세요.',
          'Buy them in the shop, or pick them up in the wild.',
          'ショップで かうか、やせいで ひろおう。',
          'Cómpralas en la tienda o recógelas en estado salvaje.',
        ),
      }
    case 'items':
      return {
        title: t(lang, '도구가 없어요', 'No items', 'どうぐが ない', 'No tienes objetos'),
        hint: t(
          lang,
          '이상한사탕, 민트, 빛나는부적은 상점에 있어요.',
          'Rare Candy, Mints and the Shiny Charm are in the shop.',
          'ふしぎなアメ、ミント、ひかるおまもりは ショップに ある。',
          'Caramelos Raros, Mentas y el Amuleto Iris están en la tienda.',
        ),
      }
  }
}

/** The empty bag's way out: to the shop. */
export function emptyBagAction(lang: AppLanguage): string {
  return t(lang, '상점으로', 'Go to the shop', 'ショップへ', 'Ir a la tienda')
}

/** A shop drawer folded: how many things, and the cheapest. */
export function shopGroupSummary(lang: AppLanguage, count: number, from: string): string {
  return t(
    lang,
    `${count}개 · ${from}부터`,
    `${count} · from ${from}`,
    `${count}こ · ${from}から`,
    `${count} · desde ${from}`,
  )
}

/** An evolution's detail in the news: the form it registered on the way. */
export function registeredOnTheWay(lang: AppLanguage, name: string): string {
  return t(lang, `${name} 등록 완료`, `${name} registered`, `${name} とうろくずみ`, `${name} registrado`)
}

// MARK: - Pokédex entry (plan 9.7)

/** A base stat by the games' own name. */
export function statLabel(
  lang: AppLanguage,
  stat: 'hp' | 'attack' | 'defense' | 'specialAttack' | 'specialDefense' | 'speed',
): string {
  switch (stat) {
    case 'hp':
      return t(lang, 'HP', 'HP', 'HP', 'PS')
    case 'attack':
      return t(lang, '공격', 'Attack', 'こうげき', 'Ataque')
    case 'defense':
      return t(lang, '방어', 'Defense', 'ぼうぎょ', 'Defensa')
    case 'specialAttack':
      return t(lang, '특수공격', 'Sp. Atk', 'とくこう', 'At. Esp.')
    case 'specialDefense':
      return t(lang, '특수방어', 'Sp. Def', 'とくぼう', 'Def. Esp.')
    case 'speed':
      return t(lang, '스피드', 'Speed', 'すばやさ', 'Velocidad')
  }
}

export function statTotalText(lang: AppLanguage, total: number): string {
  return t(lang, `합계 ${total}`, `Total ${total}`, `ごうけい ${total}`, `Total ${total}`)
}

export function dexEntryLabels(lang: AppLanguage): {
  height: string
  weight: string
  stats: string
  line: string
} {
  return {
    height: t(lang, '키', 'Height', 'たかさ', 'Altura'),
    weight: t(lang, '몸무게', 'Weight', 'おもさ', 'Peso'),
    stats: t(lang, '종족값', 'Base stats', 'しゅぞくち', 'Estadísticas base'),
    line: t(lang, '진화', 'Evolution', 'しんか', 'Evolución'),
  }
}

/** A measure with the language's decimal mark: `0.8 m`, `0,8 m`. */
export function dexMeasureText(lang: AppLanguage, value: number, unit: 'm' | 'kg'): string {
  const plain = value.toFixed(1)
  return `${t(lang, plain, plain, plain, plain.replace('.', ','))} ${unit}`
}

/** Where the entry's text, size and stats would be, while the species is only seen. */
export function dexEntryLockedText(lang: AppLanguage): string {
  return t(
    lang,
    '얻으면 도감 설명과 능력치가 채워져요.',
    'Obtain it to fill in its entry and stats.',
    'てに いれると ずかんの せつめいと のうりょくが うまる。',
    'Obtenlo para completar su entrada y sus estadísticas.',
  )
}

/** No network and nothing cached yet. */
export function dexEntryUnavailableText(lang: AppLanguage): string {
  return t(
    lang,
    '도감 설명을 처음 열 때는 인터넷 연결이 필요해요.',
    'The entry needs a connection the first time it opens.',
    'はじめて ひらくときは インターネットに つなぐ ひつようが ある。',
    'La entrada necesita conexión la primera vez que se abre.',
  )
}

/** How many of an item, as a ball, a berry, a find or a bag row prints it: `×7`, every language. */
export function itemCountText(count: number): string {
  return `×${count}`
}

/** A registration's date, short and in the editor's locale: "Oct 21, 2026", "21 oct 2026". */
export function registeredDateText(date: Date, locale: string | undefined): string {
  return date.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** The registration date as a sentence, for a tooltip and screen readers. */
export function registeredOnText(lang: AppLanguage, date: string): string {
  return t(lang, `${date} 등록`, `Registered on ${date}`, `${date}に とうろく`, `Registrado el ${date}`)
}
