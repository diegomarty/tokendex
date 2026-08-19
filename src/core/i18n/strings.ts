/**
 * UI strings.
 *
 * Mechanically extracted rather than retyped: 191 entries across four languages is exactly
 * the kind of transcription a human (or a model) gets subtly wrong, and a single swapped
 * translation is invisible until a user in that language sees it.
 *
 * Pokémon names do NOT come from here — they arrive from PokéAPI's multilingual data.
 *
 * NOTE: this file is generated, and the brand names in it were corrected by hand afterwards.
 * Re-running the extractor will reintroduce the stale ones.
 */

import type { AppLanguage } from '../companion/model.js'

/** ko, en, ja, es — the order every table below uses. */
type Quad = readonly [string, string, string, string]

const INDEX: Record<AppLanguage, 0 | 1 | 2 | 3> = { ko: 0, en: 1, ja: 2, es: 3 }

function pick(lang: AppLanguage, quad: Quad): string {
  return quad[INDEX[lang]]
}

const STRINGS = {
  home: [`홈`, `Home`, `ホーム`, `Inicio`],
  collection: [`컬렉션`, `Collection`, `コレクション`, `Colección`],
  todayTokens: [`오늘 사용한 토큰`, `Today's tokens`, `本日のトークン`, `Tokens de hoy`],
  thisWeek: [`이번 주`, `This week`, `今週`, `Esta semana`],
  thisMonth: [`이번 달`, `This month`, `今月`, `Este mes`],
  limitsOfficial: [`한도 (공식)`, `Limits (official)`, `上限（公式）`, `Límites (oficial)`],
  fiveHourSession: [`5시간 세션`, `5-hour session`, `5時間セッション`, `Sesión de 5 horas`],
  weekly: [`주간`, `Weekly`, `週間`, `Semanal`],
  weeklyOpus: [`주간 Opus`, `Weekly Opus`, `週間 Opus`, `Opus semanal`],
  weeklySonnet: [`주간 Sonnet`, `Weekly Sonnet`, `週間 Sonnet`, `Sonnet semanal`],
  claudeCurrentBlock: [
    `Claude 현재 5h 블록`,
    `Claude current 5h block`,
    `Claude 現在の5hブロック`,
    `Bloque actual de 5h de Claude`,
  ],
  reset: [`리셋`, `Reset`, `リセット`, `Reinicio`],
  limitReached: [`한도 도달`, `Limit reached`, `上限到達`, `Límite alcanzado`],
  personalSpendLimit: [
    `개인 사용 한도`,
    `Personal spend limit`,
    `個人利用上限`,
    `Límite de gasto personal`,
  ],
  staleLimits: [`갱신 지연`, `Stale`, `更新遅延`, `Desactualizado`],
  refresh: [`갱신`, `Refresh`, `更新`, `Actualizar`],
  limitsTapToLoad: [
    `공식 한도 불러오기`,
    `Load official limits`,
    `公式上限を読み込む`,
    `Cargar límites oficiales`,
  ],
  forecastNoReach: [
    `현재 속도로는 리셋 전 한도 도달 없음`,
    `Won't hit limit before reset at current rate`,
    `現在のペースではリセット前に上限到達なし`,
    `Al ritmo actual, no alcanzarás el límite antes del reinicio`,
  ],
  refreshNow: [`지금 새로고침`, `Refresh now`, `今すぐ更新`, `Actualizar ahora`],
  updated: [`갱신`, `Updated`, `更新`, `Actualizado`],
  settings: [`설정`, `Settings`, `設定`, `Ajustes`],
  back: [`뒤로`, `Back`, `戻る`, `Atrás`],
  generalSectionTitle: [`일반`, `General`, `一般`, `General`],
  menuBarSectionTitle: [
    `메뉴바에 표시`,
    `Show in menu bar`,
    `メニューバーに表示`,
    `Mostrar en la barra de menús`,
  ],
  advancedSectionTitle: [`고급`, `Advanced`, `詳細`, `Avanzado`],
  advancedDisclosureLabel: [
    `고급 설정 · 진단`,
    `Advanced · diagnostics`,
    `詳細設定・診断`,
    `Avanzado · diagnóstico`,
  ],
  aboutSupportSectionTitle: [`정보 & 지원`, `About & Support`, `情報とサポート`, `Acerca de y soporte`],
  quit: [`종료`, `Quit`, `終了`, `Salir`],
  refreshInterval: [`새로고침 간격`, `Refresh interval`, `更新間隔`, `Intervalo de actualización`],
  language: [`언어`, `Language`, `言語`, `Idioma`],
  menuBarItems: [
    `메뉴바 표시 항목 (복수 선택)`,
    `Menu bar items (multi-select)`,
    `メニューバー表示項目（複数選択）`,
    `Elementos de la barra de menús (selección múltiple)`,
  ],
  todayTokensShort: [`오늘 토큰`, `Today's tokens`, `本日のトークン`, `Tokens de hoy`],
  todayCost: [`오늘 비용 ($)`, `Today's cost ($)`, `本日のコスト ($)`, `Coste de hoy ($)`],
  limitPercent: [`한도 %`, `Limit %`, `上限 %`, `Límite %`],
  limitDisplayModeLabel: [`한도 표시 방식`, `Limit display`, `上限の表示`, `Visualización del límite`],
  limitDisplayUsed: [`사용량`, `Used`, `使用量`, `Usado`],
  limitDisplayRemaining: [`남은 양`, `Remaining`, `残量`, `Restante`],
  allOffHint: [
    `전부 끄면 캐릭터만 표시됩니다`,
    `All off shows only the character`,
    `すべてオフにするとキャラクターのみ表示`,
    `Si desactivas todo, solo se mostrará el personaje`,
  ],
  floatingPetSectionTitle: [`플로팅 펫`, `Floating Pet`, `フローティングペット`, `Mascota flotante`],
  floatingPetEnableLabel: [
    `플로팅 펫 표시`,
    `Show floating pet`,
    `フローティングペットを表示`,
    `Mostrar mascota flotante`,
  ],
  floatingPetHint: [
    `포켓몬이 화면 위에 떠 있어요 — 드래그로 위치를 옮길 수 있어요`,
    `Your Pokémon floats over the screen — drag to reposition`,
    `ポケモンが画面の上に浮かびます — ドラッグで移動できます`,
    `Tu Pokémon flota sobre la pantalla — arrástralo para moverlo`,
  ],
  floatingPetSizeLabel: [`크기`, `Size`, `サイズ`, `Tamaño`],
  floatingPetBubbleAlertsLabel: [
    `말풍선으로 알림 받기`,
    `Show notifications as bubbles`,
    `通知を吹き出しで表示`,
    `Mostrar notificaciones como globos`,
  ],
  floatingPetMenuOpen: [`토큰 바 열기`, `Open Token Bar`, `トークンバーを開く`, `Abrir Token Bar`],
  floatingPetMenuHide: [
    `플로팅 펫 끄기`,
    `Turn off floating pet`,
    `フローティングペットをオフ`,
    `Desactivar mascota flotante`,
  ],
  disableKeychain: [
    `Keychain 접근 끄기`,
    `Disable Keychain access`,
    `Keychainアクセスを無効化`,
    `Desactivar acceso a Keychain`,
  ],
  disableKeychainHint: [
    `켜면 Keychain 접근 허용 팝업이 더 안 뜹니다 — 공식 한도(%)만 숨겨지고 토큰·비용은 그대로`,
    `When on, no more Keychain permission pop-ups — only official limits (%) are hidden; tokens/cost stay`,
    `オンにするとKeychain許可のポップアップが出なくなります — 公式上限(%)のみ非表示、トークン・費用はそのまま`,
    `Al activarlo, ya no aparecerán los avisos de permiso de Keychain — solo se ocultan los límites oficiales (%), los tokens y el coste se mantienen`,
  ],
  refreshLimitToken: [
    `한도 토큰 캐시 갱신`,
    `Refresh limit token cache`,
    `上限トークンキャッシュを更新`,
    `Actualizar caché del token de límite`,
  ],
  onlyOnPress: [
    `누를 때만 Keychain 을 읽어요 — 자동 폴링은 안 읽어 팝업이 안 떠요. 토큰 만료 후 이 버튼으로 한도 갱신`,
    `Reads Keychain only when pressed — auto-polling never does, so no pop-ups. Refresh limits here after the token expires`,
    `押した時のみKeychainを読みます — 自動更新では読まずポップアップも出ません。トークン期限切れ後はこのボタンで上限を更新`,
    `Solo lee Keychain al pulsar — el sondeo automático nunca lo hace, así que no aparecen avisos. Usa este botón para actualizar los límites tras la expiración del token`,
  ],
  launchAtLogin: [
    `로그인 시 자동 시작`,
    `Launch at login`,
    `ログイン時に自動起動`,
    `Iniciar al arrancar sesión`,
  ],
  bundledOnly: [
    `.app 번들로 설치된 경우에만 사용 가능 (scripts/build-app.sh)`,
    `Available only when installed as an .app bundle (scripts/build-app.sh)`,
    `.appバンドルでインストールした場合のみ利用可能 (scripts/build-app.sh)`,
    `Disponible solo si se instaló como paquete .app (scripts/build-app.sh)`,
  ],
  notificationsSection: [`알림`, `Notifications`, `通知`, `Notificaciones`],
  limitNotificationsLabel: [`한도 알림`, `Limit alerts`, `上限通知`, `Alertas de límite`],
  companionNotificationsLabel: [
    `Companion 이벤트 (부화·진화·졸업)`,
    `Companion events (hatch / evolve / graduate)`,
    `コンパニオンイベント（孵化・進化・卒業）`,
    `Eventos del compañero (eclosión / evolución / graduación)`,
  ],
  statusChecksLabel: [
    `프로바이더 상태 확인`,
    `Provider status checks`,
    `プロバイダー状態チェック`,
    `Comprobación de estado de proveedores`,
  ],
  statusChecksHint: [
    `Claude·OpenAI 장애를 팝오버에 표시 (알림 아님)`,
    `Show Claude / OpenAI incidents in the popover (not a notification)`,
    `Claude・OpenAIの障害をポップオーバーに表示（通知ではない）`,
    `Muestra incidentes de Claude/OpenAI en el popover (no es una notificación)`,
  ],
  warning: [`경고`, `Warning`, `警告`, `Aviso`],
  critical: [`임박`, `Critical`, `切迫`, `Crítico`],
  aggregationNote: [
    `토큰 집계 기준: totalTokens (input + output + cache, 로컬 날짜)`,
    `Token basis: totalTokens (input + output + cache, local date)`,
    `集計基準: totalTokens (input + output + cache, ローカル日付)`,
    `Base de cálculo: totalTokens (input + output + cache, fecha local)`,
  ],
  close: [`닫기`, `Close`, `閉じる`, `Cerrar`],
  transferSectionTitle: [
    `백업 & 이전`,
    `Backup & Transfer`,
    `バックアップと移行`,
    `Copia de seguridad y transferencia`,
  ],
  exportSaveLabel: [`세이브 내보내기`, `Export save`, `セーブを書き出す`, `Exportar partida`],
  exportSaveHint: [
    `도감·누적 토큰·가방·현재 포켓몬을 파일 하나로 저장해요`,
    `Saves your Pokédex, lifetime tokens, Bag, and current Pokémon as one file`,
    `図鑑・累計トークン・バッグ・現在のポケモンを1つのファイルに保存します`,
    `Guarda tu Pokédex, tokens acumulados, Bolsa y Pokémon actual en un solo archivo`,
  ],
  exportSaveButton: [`내보내기…`, `Export…`, `書き出す…`, `Exportar…`],
  importSaveLabel: [`세이브 불러오기`, `Import save`, `セーブを読み込む`, `Importar partida`],
  importSaveHint: [
    `다른 Mac에서 내보낸 파일을 골라 이 Mac으로 이어서 키워요`,
    `Pick a file exported from another Mac and continue here`,
    `他のMacから書き出したファイルを選んでこのMacで続けます`,
    `Elige un archivo exportado desde otro Mac y continúa aquí`,
  ],
  importSaveButton: [`불러오기…`, `Import…`, `読み込む…`, `Importar…`],
  importConfirmTitle: [
    `이 Mac의 진행을 대체할까요?`,
    `Replace this Mac's progress?`,
    `このMacの進行を置き換えますか？`,
    `¿Reemplazar el progreso de este Mac?`,
  ],
  importConfirmReplace: [`대체`, `Replace`, `置き換える`, `Reemplazar`],
  importErrorNotSaveFile: [
    `Tokendex 세이브 파일이 아니에요.`,
    `That isn't a Tokendex save file.`,
    `Tokendex のセーブファイルではありません。`,
    `Ese no es un archivo de partida de Tokendex.`,
  ],
  importErrorNewerSchema: [
    `더 새로운 버전에서 만든 세이브예요 — 앱을 업데이트한 뒤 다시 시도해 주세요.`,
    `This save was made by a newer version — update the app and try again.`,
    `より新しいバージョンで作成されたセーブです — アプリを更新してから再試行してください。`,
    `Esta partida se creó con una versión más reciente — actualiza la app e inténtalo de nuevo.`,
  ],
  importErrorTooLarge: [
    `세이브 파일이라기엔 너무 커요 — 다른 파일을 고른 것 같아요.`,
    `That file is too large to be a save — it looks like the wrong file.`,
    `セーブファイルにしては大きすぎます — 別のファイルを選んだようです。`,
    `Ese archivo es demasiado grande para ser una partida — parece que elegiste el archivo equivocado.`,
  ],
  importErrorBackupFailed: [
    `현재 상태를 백업하지 못해 불러오기를 중단했어요 — 진행은 그대로예요. 디스크 여유 공간을 확인해 주세요.`,
    `Import stopped because the current state couldn't be backed up — your progress is untouched. Check free disk space.`,
    `現在の状態をバックアップできなかったため読み込みを中止しました — 進行はそのままです。ディスクの空き容量を確認してください。`,
    `Se detuvo la importación porque no se pudo hacer una copia de seguridad del estado actual — tu progreso no se ha tocado. Comprueba el espacio libre en disco.`,
  ],
  reportProblem: [`문제점 알리기`, `Report a problem`, `問題を報告`, `Reportar un problema`],
  showLogFile: [`로그 파일 보기`, `Show log file`, `ログファイルを表示`, `Mostrar archivo de registro`],
  reportAttachHint: [
    `메일에 로그 파일을 첨부해 주시면 원인 파악에 큰 도움이 돼요.`,
    `Attaching the log file to the email helps a lot with diagnosis.`,
    `メールにログファイルを添付していただくと原因の特定に役立ちます。`,
    `Adjuntar el archivo de registro al correo ayuda mucho a diagnosticar el problema.`,
  ],
  finalForm: [`최종 진화체`, `Final form`, `最終進化`, `Forma final`],
  unknownNextEvolution: [
    `알 수 없는 다음 진화`,
    `Unknown next evolution`,
    `次の進化先は不明`,
    `Próxima evolución desconocida`,
  ],
  eggIncubating: [`🥚 부화 준비 중`, `🥚 Incubating`, `🥚 孵化の準備中`, `🥚 Incubando`],
  dexEmptyTitle: [
    `아직 잡은 포켓몬이 없어요!`,
    `No Pokémon caught yet!`,
    `まだ捕まえたポケモンがいません！`,
    `¡Todavía no has capturado ningún Pokémon!`,
  ],
  dexEmptyHint: [
    `토큰을 써서 첫 포켓몬을 부화시켜 보세요.`,
    `Spend tokens to hatch your first Pokémon.`,
    `トークンを使って最初のポケモンを孵化させましょう。`,
    `Usa tokens para eclosionar tu primer Pokémon.`,
  ],
  dexTitle: [`도감`, `Pokédex`, `図鑑`, `Pokédex`],
  catchLogTitle: [`포획 로그`, `Catch log`, `捕獲ログ`, `Registro de capturas`],
  dexPagePrev: [`이전 페이지`, `Previous page`, `前のページ`, `Página anterior`],
  dexPageNext: [`다음 페이지`, `Next page`, `次のページ`, `Página siguiente`],
  dexRaising: [`키우는 중`, `Raising`, `育成中`, `Criando`],
  rarityCommon: [`일반`, `Common`, `ノーマル`, `Común`],
  rarityUncommon: [`고급`, `Uncommon`, `アンコモン`, `Poco común`],
  rarityRare: [`희귀`, `Rare`, `レア`, `Raro`],
  rarityLegendary: [`전설`, `Legendary`, `伝説`, `Legendario`],
  dexFilterHint: [
    `탭하면 이 희귀도만 보기 · 다시 탭하면 전체`,
    `Tap to show only this rarity · tap again to clear`,
    `タップでこの希少度のみ表示・再タップで全体`,
    `Toca para ver solo esta rareza · toca de nuevo para ver todo`,
  ],
  dexShinyLabel: [`이로치`, `Shiny`, `色違い`, `Variocolor`],
  statusEgg: [`곧 깨어나요.`, `Hatching soon.`, `もうすぐ孵化します。`, `Está a punto de eclosionar.`],
  statusIdle: [
    `오늘은 조용히 자리를 지켜요.`,
    `Keeping quiet today.`,
    `今日は静かにしています。`,
    `Hoy se mantiene tranquilo.`,
  ],
  statusWorking: [
    `오늘의 작업 흔적이 쌓이고 있어요.`,
    `Today's work is piling up.`,
    `本日の作業が積み重なっています。`,
    `El trabajo de hoy se va acumulando.`,
  ],
  statusFocus: [
    `지금은 집중 모드예요.`,
    `In focus mode now.`,
    `今は集中モードです。`,
    `Ahora está en modo concentración.`,
  ],
  statusTired: [
    `한도에 가까워요. 잠깐 쉬어도 괜찮아요.`,
    `Close to the limit. A short break is fine.`,
    `上限が近いです。少し休んでも大丈夫。`,
    `Está cerca del límite. Un pequeño descanso no vendría mal.`,
  ],
  statusSleep: [`지금은 자고 있어요.`, `Sleeping now.`, `今は眠っています。`, `Ahora está durmiendo.`],
  statusGrew: [`성장했어요!`, `It grew!`, `成長しました！`, `¡Ha crecido!`],
  notifHatchTitle: [`🥚 부화!`, `🥚 Hatched!`, `🥚 孵化！`, `🥚 ¡Eclosionó!`],
  notifShinyHatchTitle: [
    `✨ 이로치 포켓몬!`,
    `✨ Shiny Pokémon!`,
    `✨ 色違いポケモン！`,
    `✨ ¡Pokémon variocolor!`,
  ],
  eggImminent: [`곧 부화해요!`, `About to hatch!`, `もうすぐ孵化！`, `¡Está a punto de eclosionar!`],
  eggFirstRunHint: [
    `로컬 AI 코딩 도구의 사용량으로 자라요. 약 5M 토큰을 쓰면 알이 부화해요.`,
    `Grows from your local AI coding usage. Your egg hatches after ~5M tokens.`,
    `ローカルの AI コーディング使用量で育ちます。約5Mトークンでタマゴが孵化します。`,
    `Crece con el uso de tus herramientas locales de programación con IA. Tu huevo eclosiona tras unos 5M de tokens.`,
  ],
  notifEvolveTitle: [`✨ 진화!`, `✨ Evolved!`, `✨ 進化！`, `✨ ¡Evolucionó!`],
  notifDittoRevealTitle: [
    `🎭 어라? 메타몽!`,
    `🎭 Huh? It's Ditto!`,
    `🎭 あれ？メタモン！`,
    `🎭 ¿Eh? ¡Es Ditto!`,
  ],
  notifShinyDittoRevealTitle: [
    `🎭✨ 어라? 이로치 메타몽!`,
    `🎭✨ Huh? A shiny Ditto!`,
    `🎭✨ あれ？色違いメタモン！`,
    `🎭✨ ¿Eh? ¡Un Ditto variocolor!`,
  ],
  notifGraduateTitle: [`🎓 졸업!`, `🎓 Graduated!`, `🎓 卒業！`, `🎓 ¡Graduado!`],
  limitRefreshNoCredential: [
    `Claude 자격증명을 찾지 못했어요. Claude Code 에 로그인하면 한도가 표시됩니다. Codex만 쓴다면 무시해도 돼요.`,
    `No Claude credential found. Sign in to Claude Code to see limits. If you only use Codex you can ignore this.`,
    `Claude の認証情報が見つかりません。Claude Code にサインインすると上限が表示されます。Codex のみなら無視して構いません。`,
    `No se encontró ninguna credencial de Claude. Inicia sesión en Claude Code para ver los límites. Si solo usas Codex, puedes ignorar esto.`,
  ],
  limitRefreshReauthNeeded: [
    `Claude 자격증명에 계정 로그인 정보가 없어요. Claude Code 에서 \`/login\` 으로 다시 로그인하면 한도가 표시됩니다.`,
    `Your Claude credential has no account sign-in. Run \`/login\` in Claude Code to sign in again and limits will appear.`,
    `Claude の認証情報にアカウントのサインインが含まれていません。Claude Code で \`/login\` を実行して再度サインインすると上限が表示されます。`,
    `Tu credencial de Claude no tiene una sesión de cuenta asociada. Ejecuta \`/login\` en Claude Code para volver a iniciar sesión y ver los límites.`,
  ],
  limitRefreshGeneric: [
    `Claude 한도 조회에 실패했어요. 잠시 후 다시 시도하세요.`,
    `Couldn't fetch Claude limits. Please try again shortly.`,
    `Claude の上限取得に失敗しました。しばらくして再試行してください。`,
    `No se pudieron obtener los límites de Claude. Inténtalo de nuevo en unos momentos.`,
  ],
  limitRefreshRateLimited: [
    `Claude 한도 조회가 일시 제한됐어요 (429). 잠시 쉬었다가 자동으로 재시도합니다.`,
    `Claude limit checks are temporarily rate-limited (429). Backing off and retrying automatically.`,
    `Claude の上限取得が一時的に制限されています (429)。少し待って自動的に再試行します。`,
    `Las comprobaciones de límites de Claude están temporalmente limitadas (429). Se reintentará automáticamente en breve.`,
  ],
  claudeAuthExpiredTitle: [
    `Claude 세션 만료 — 한도가 갱신 안 돼요`,
    `Claude session expired — limits can't refresh`,
    `Claude セッション期限切れ — 上限を更新できません`,
    `Sesión de Claude expirada — los límites no se pueden actualizar`,
  ],
  claudeAuthExpiredHint: [
    `표시된 값은 만료 전 기준이에요. 다시 시도하거나, Claude Code 를 한 번 실행하면 자동 갱신됩니다.`,
    `Values shown are from before expiry. Retry, or run Claude Code once to refresh automatically.`,
    `表示値は期限切れ前のものです。再試行するか、Claude Code を一度実行すると自動更新されます。`,
    `Los valores mostrados son de antes de la expiración. Reinténtalo, o ejecuta Claude Code una vez para actualizarlos automáticamente.`,
  ],
  retry: [`다시 시도`, `Retry`, `再試行`, `Reintentar`],
  updateButton: [`업데이트`, `Update`, `更新`, `Actualizar`],
  updateLater: [`나중에`, `Later`, `後で`, `Más tarde`],
  updating: [`업데이트 중…`, `Updating…`, `更新中…`, `Actualizando…`],
  updateSectionTitle: [`업데이트`, `Updates`, `アップデート`, `Actualizaciones`],
  updateNotificationsLabel: [
    `업데이트 알림`,
    `Update notifications`,
    `アップデート通知`,
    `Notificaciones de actualización`,
  ],
  checkForUpdatesLabel: [
    `업데이트 확인`,
    `Check for updates`,
    `アップデートを確認`,
    `Buscar actualizaciones`,
  ],
  checkNowButton: [`지금 확인`, `Check now`, `今すぐ確認`, `Comprobar ahora`],
  notifCritical: [`한도 임박`, `Limit imminent`, `上限切迫`, `Límite inminente`],
  notifWarning: [`한도 경고`, `Limit warning`, `上限警告`, `Aviso de límite`],
  claudeFiveHour: [
    `Claude 5시간 세션`,
    `Claude 5-hour session`,
    `Claude 5時間セッション`,
    `Sesión de 5 horas de Claude`,
  ],
  claudeWeekly: [`Claude 주간`, `Claude weekly`, `Claude 週間`, `Semanal de Claude`],
  codexPersonalLimit: [
    `Codex 개인 한도`,
    `Codex personal limit`,
    `Codex 個人上限`,
    `Límite personal de Codex`,
  ],
  bag: [`가방`, `Bag`, `バッグ`, `Bolsa`],
  bagEmptyTitle: [
    `아직 가방이 비어있어요!`,
    `Your bag is empty!`,
    `バッグはまだ空っぽです！`,
    `¡Tu bolsa todavía está vacía!`,
  ],
  useItem: [`사용하기`, `Use`, `つかう`, `Usar`],
  use: [`사용`, `Use`, `つかう`, `Usar`],
  cancel: [`취소`, `Cancel`, `キャンセル`, `Cancelar`],
  useAfterHatch: [
    `부화 후 사용할 수 있어요`,
    `Usable after hatching`,
    `孵化後に使えます`,
    `Se puede usar después de eclosionar`,
  ],
  useNeedsPokemon: [
    `사용할 포켓몬이 없어요`,
    `No Pokémon to use it on`,
    `使えるポケモンがいません`,
    `No hay ningún Pokémon en quien usarlo`,
  ],
  mintEffectHint: [`성격 랜덤 변경`, `Random nature`, `せいかくランダム変更`, `Naturaleza aleatoria`],
  shop: [`상점`, `Shop`, `ショップ`, `Tienda`],
  spendableTokens: [`쓸 수 있는 토큰`, `Spendable tokens`, `使えるトークン`, `Tokens disponibles`],
  shopHint: [
    `사용한 토큰으로 아이템을 살 수 있어요.`,
    `Spend the tokens you've used on items.`,
    `使ったトークンでアイテムを購入できます。`,
    `Usa los tokens que has consumido para comprar objetos.`,
  ],
  buy: [`구매`, `Buy`, `購入`, `Comprar`],
  notEnoughTokens: [
    `토큰이 부족해요`,
    `Not enough tokens`,
    `トークンが足りません`,
    `No tienes suficientes tokens`,
  ],
  shopPriceLabel: [`가격`, `Price`, `価格`, `Precio`],
  ownedAlready: [`보유 중`, `Owned`, `所持済み`, `En posesión`],
  shinyCharmEffectHint: [
    `이로치 확률 ↑ · 적용 중`,
    `Shiny rate ↑ · active`,
    `色違い率↑ · 適用中`,
    `Prob. variocolor ↑ · activo`,
  ],
  freshEggShinyWarning: [
    `⚠️ 이로치 포켓몬이에요! 정말 놓아줄까요?`,
    `⚠️ This one is shiny! Really send it off?`,
    `⚠️ 色違いです！本当に手放しますか？`,
    `⚠️ ¡Este es variocolor! ¿Seguro que quieres soltarlo?`,
  ],
  freshEggDiscardShiny: [`이로치 놓아주기`, `Send shiny off`, `手放す`, `Soltar variocolor`],
} as const satisfies Record<string, Quad>

export type StringKey = keyof typeof STRINGS

/** Look up a plain string. */
export function s(lang: AppLanguage, key: StringKey): string {
  return pick(lang, STRINGS[key])
}

/** Parameterised strings. */
export const f = {
  forecastReach: (lang: AppLanguage, time: string): string =>
    pick(lang, [
      `현재 속도면 ${time} 한도 도달`,
      `At current rate, limit hit at ${time}`,
      `現在のペースで ${time} に上限到達`,
      `Al ritmo actual, límite alcanzado a las ${time}`,
    ]),
  floatingPetHoverTokensOnly: (lang: AppLanguage, tokens: string): string =>
    pick(lang, [
      `오늘 ${tokens} 토큰`,
      `Today: ${tokens} tokens`,
      `今日: ${tokens} トークン`,
      `Hoy: ${tokens} tokens`,
    ]),
  floatingPetHoverWithLimit: (lang: AppLanguage, tokens: string, percent: string): string =>
    pick(lang, [
      `오늘 ${tokens} 토큰 (한도 ${percent})`,
      `Today: ${tokens} tokens (limit ${percent})`,
      `今日: ${tokens} トークン（上限 ${percent}）`,
      `Hoy: ${tokens} tokens (límite ${percent})`,
    ]),
  importConfirmBody: (
    lang: AppLanguage,
    incomingDex: number,
    incomingTokens: string,
    exportedAt: string,
    sourceDevice: string,
    currentDex: number,
    currentTokens: string,
  ): string =>
    pick(lang, [
      `""
          불러올 세이브: 도감 ${incomingDex}마리 · 누적 ${incomingTokens}
          내보낸 시각: ${exportedAt} · ${sourceDevice}
          현재 이 Mac: 도감 ${currentDex}마리 · 누적 ${currentTokens}

          이 Mac의 현재 진행은 대체됩니다. 직전 상태는 상태 폴더에 백업으로 남습니다(최근 5개).
          ""`,
      `""
          Incoming save: ${incomingDex} in Pokédex · ${incomingTokens} lifetime
          Exported: ${exportedAt} · ${sourceDevice}
          This Mac now: ${currentDex} in Pokédex · ${currentTokens} lifetime

          This Mac's current progress is replaced. The previous state is kept as a backup in the state folder (last 5).
          ""`,
      `""
          読み込むセーブ: 図鑑 ${incomingDex}匹 · 累計 ${incomingTokens}
          書き出し日時: ${exportedAt} · ${sourceDevice}
          現在のこのMac: 図鑑 ${currentDex}匹 · 累計 ${currentTokens}

          このMacの現在の進行は置き換えられます。直前の状態は状態フォルダにバックアップとして残ります（最新5件）。
          ""`,
      `""
          Partida a importar: Pokédex ${incomingDex} · ${incomingTokens} acumulados
          Exportada: ${exportedAt} · ${sourceDevice}
          Este Mac ahora: Pokédex ${currentDex} · ${currentTokens} acumulados

          El progreso actual de este Mac será reemplazado. El estado anterior se guarda como copia de seguridad en la carpeta de estado (últimas 5).
          ""`,
    ]),
  importSaveDone: (lang: AppLanguage, dex: number, tokens: string): string =>
    pick(lang, [
      `불러왔어요 — 도감 ${dex}마리 · 누적 ${tokens}`,
      `Imported — ${dex} in Pokédex · ${tokens} lifetime`,
      `読み込みました — 図鑑 ${dex}匹 · 累計 ${tokens}`,
      `Importado — Pokédex ${dex} · ${tokens} acumulados`,
    ]),
  reportMailSubject: (lang: AppLanguage, version: string): string =>
    pick(lang, [
      `[Tokendex] 문제 리포트 (v${version})`,
      `[Tokendex] Problem report (v${version})`,
      `[Tokendex] 問題レポート (v${version})`,
      `[Tokendex] Reporte de problema (v${version})`,
    ]),
  reportMailBody: (lang: AppLanguage, version: string, os: string): string =>
    pick(lang, [
      `""
        문제 내용:
        (겪으신 문제를 적어주세요 — 언제, 어떤 화면에서, 어떻게 되었는지)


        ---
        앱 버전: v${version}
        macOS: ${os}
        로그 파일(첨부 권장): ~/Library/Logs/Tokendex.log
        ""`,
      `""
        What happened:
        (Describe the problem — when, on which screen, and what you saw)


        ---
        App version: v${version}
        macOS: ${os}
        Log file (please attach): ~/Library/Logs/Tokendex.log
        ""`,
      `""
        問題の内容:
        （いつ・どの画面で・どうなったかをご記入ください）


        ---
        アプリのバージョン: v${version}
        macOS: ${os}
        ログファイル（添付推奨）: ~/Library/Logs/Tokendex.log
        ""`,
      `""
        Descripción del problema:
        (Describe lo que ocurrió — cuándo, en qué pantalla y qué viste)


        ---
        Versión de la app: v${version}
        macOS: ${os}
        Archivo de registro (se recomienda adjuntar): ~/Library/Logs/Tokendex.log
        ""`,
    ]),
  eggToHatch: (lang: AppLanguage, amount: string): string =>
    pick(lang, [
      `부화까지 ${amount}`,
      `${amount} to hatch`,
      `孵化まで ${amount}`,
      `${amount} para eclosionar`,
    ]),
  toNextEvolution: (lang: AppLanguage, amount: string): string =>
    pick(lang, [
      `다음 진화까지 ${amount}`,
      `${amount} to next evolution`,
      `次の進化まで ${amount}`,
      `${amount} para la siguiente evolución`,
    ]),
  toGraduation: (lang: AppLanguage, amount: string): string =>
    pick(lang, [
      `졸업까지 ${amount}`,
      `${amount} to graduation`,
      `卒業まで ${amount}`,
      `${amount} para graduarse`,
    ]),
  graduated: (lang: AppLanguage, name: string): string =>
    pick(lang, [
      `${name} 졸업 → 도감에 보존. 새 Token Egg가 도착했어요!`,
      `${name} graduated → saved to the dex. A new Token Egg has arrived!`,
      `${name} 卒業 → 図鑑に保存。新しいToken Eggが届きました！`,
      `${name} se graduó → guardado en la Pokédex. ¡Ha llegado un nuevo Token Egg!`,
    ]),
  dexTotal: (lang: AppLanguage, n: number): string =>
    pick(lang, [`총 ${n}마리`, `${n} total`, `全${n}匹`, `${n} en total`]),
  dexSpeciesTotal: (lang: AppLanguage, n: number): string =>
    pick(lang, [`${n}종`, `${n} species`, `${n}種`, `${n} especies`]),
  dexPageLabel: (lang: AppLanguage, page: number, total: number): string =>
    pick(lang, [
      `${total}페이지 중 ${page}페이지`,
      `Page ${page} of ${total}`,
      `${total}ページ中 ${page}ページ`,
      `Página ${page} de ${total}`,
    ]),
  notifHatchBody: (lang: AppLanguage, name: string): string =>
    pick(lang, [
      `알에서 ${name}이(가) 나왔어요!`,
      `${name} hatched from the egg!`,
      `タマゴから ${name} が生まれました！`,
      `¡${name} salió del huevo!`,
    ]),
  notifShinyHatchBody: (lang: AppLanguage, name: string): string =>
    pick(lang, [
      `이로치 ${name}이(가) 태어났어요! (1/64)`,
      `A shiny ${name} hatched! (1 in 64)`,
      `色違いの ${name} が生まれました！(1/64)`,
      `¡Nació un ${name} variocolor! (1 entre 64)`,
    ]),
  notifEvolveBody: (lang: AppLanguage, name: string): string =>
    pick(lang, [
      `${name}(으)로 진화했어요!`,
      `Evolved into ${name}!`,
      `${name} に進化しました！`,
      `¡Evolucionó a ${name}!`,
    ]),
  notifDittoRevealBody: (lang: AppLanguage, disguise: string): string =>
    pick(lang, [
      `${disguise}인 줄 알았는데 — 사실은 메타몽이었어요!`,
      `You thought it was ${disguise} — it was Ditto all along!`,
      `${disguise} だと思ってた… 実はメタモンでした！`,
      `Pensabas que era ${disguise} — ¡en realidad era Ditto!`,
    ]),
  notifShinyDittoRevealBody: (lang: AppLanguage, disguise: string): string =>
    pick(lang, [
      `${disguise}인 줄 알았는데 — 이로치 메타몽이었어요! (1/64)`,
      `You thought it was ${disguise} — it was a shiny Ditto! (1 in 64)`,
      `${disguise} だと思ってた… 色違いのメタモンでした！(1/64)`,
      `Pensabas que era ${disguise} — ¡era un Ditto variocolor! (1 entre 64)`,
    ]),
  notifGraduateBody: (lang: AppLanguage, name: string): string =>
    pick(lang, [
      `${name} — 도감에 보존! 새 알이 도착했어요.`,
      `${name} — saved to your Pokédex! A new egg has arrived.`,
      `${name} — 図鑑に保存！新しいタマゴが届きました。`,
      `${name} — ¡guardado en tu Pokédex! Ha llegado un nuevo huevo.`,
    ]),
  updateFound: (lang: AppLanguage, version: string): string =>
    pick(lang, [
      `새 버전 v${version} 있어요`,
      `Version ${version} is available`,
      `バージョン ${version} が利用可能です`,
      `La versión ${version} está disponible`,
    ]),
  upToDate: (lang: AppLanguage, version: string): string =>
    pick(lang, [
      `최신 버전이에요 (v${version})`,
      `You're on the latest (v${version})`,
      `最新です (v${version})`,
      `Tienes la última versión (v${version})`,
    ]),
  notifBody: (lang: AppLanguage, name: string, percent: string): string =>
    pick(lang, [
      `${name} 한도 ${percent} 사용`,
      `${name} at ${percent}`,
      `${name} 上限 ${percent} 使用`,
      `${name} al ${percent}`,
    ]),
  useOnCurrent: (lang: AppLanguage, name: string): string =>
    pick(lang, [
      `${name}에게 사용할까요?`,
      `Use on ${name}?`,
      `${name} に使いますか？`,
      `¿Usar en ${name}?`,
    ]),
  ownedCount: (lang: AppLanguage, n: number): string =>
    pick(lang, [`보유 ×${n}`, `Owned ×${n}`, `所持 ×${n}`, `En posesión ×${n}`]),
  notifCandyTitle: (lang: AppLanguage, item: string, count: number): string =>
    pick(lang, [
      `🍬 ${item} ${count}개를 받았어요!`,
      `🍬 You got ${count}× ${item}!`,
      `🍬 ${item}を${count}個もらいました！`,
      `🍬 ¡Has recibido ${count}× ${item}!`,
    ]),
  notifCandyBody: (lang: AppLanguage, window: string): string =>
    pick(lang, [
      `${window} 토큰 한도를 다 채웠어요. 열심히 쓴 만큼 사탕을 드려요 — 포켓몬에게 써서 진화시켜 보세요!`,
      `You maxed out your ${window} token limit. A treat for the effort — use it to evolve your Pokémon!`,
      `${window}のトークン上限を使い切りました。がんばったごほうびです — ポケモンに使って進化させよう！`,
      `Has agotado tu límite de tokens ${window}. Un premio por el esfuerzo — ¡úsalo para evolucionar a tu Pokémon!`,
    ]),
} as const
