# Fase 3 — Capturar = registrar

**Plan maestro:** `00-master.md` § Fase 3. Hereda "captura 5 %", "duplicado da tokens" y las reglas anti-abuso de C6.
**Estado:** detallado (2026-10-20), en implementación.
**Depende de:** fase 1 (mapa `species`), fase 1b (recompensa por duplicado validada).

## Objetivo

Que capturar tenga valor de colección: desbloquea la especie y suma el 5 % de su `registerXP`; si ya estaba desbloqueada, da tokens.

## Alcance

- `encounters.ts` (`takeTurn`, rama `caught`): en lugar de solo `wildDexEntry`, `creditSpeciesXP(5 %)` + `unlocked` + `caught++`; si ya estaba desbloqueada, `earnedTokens += EconomyBalance.duplicateReward[lineRarity]` (campo nuevo de la fase 1; restar de `spentTokens` se perdería por el acotado a ≥ 0 de `sanitized`). Si la línea no está cargada al capturar (sin red), el 5 % se aplica cuando se carga: se guarda `pendingShare` en la especie (campo de la fase 1). Antes de la fase 3b solo aparecen especies base, así que `lineRarity = encounter.rarity` es válido y con él se calcula el duplicado; la 3b pasa al `lineRarity` del índice. La recompensa entra en `earnedTokens`, y las dos lecturas inline del monedero (`stealAmount`, `trackLegendary`) ya pasan por `spendableBalance` desde la fase 1.
- El historial de capturas (`dex` con `source: 'wild'`) se mantiene para el registro cronológico.
- `dispatch.ts`: texto del resultado con el % y la recompensa ("¡Caterpie registrado al 5 %!", "Ya lo tenías: +3M tokens").
- `panel/build.ts` y webview: el resultado de la captura muestra ambos datos; la animación del saldo (ya existe) juega el +N.

## Preguntas abiertas

- Un salvaje **shiny** capturado: además del 5 %, marca `shinyUnlocked` (eje shiny del panel, independiente del `status`); la fase 5 lo convierte en barra completa.
- Legendarios rastreados (`trackedCount`) capturados: ¿recompensa normal? Sí.

## Diseño detallado

1. **Constante.** `EconomyBalance.catchShare = 0.05` en `economy.ts`, junto a `duplicateReward` (una tabla).
2. **Captura de especie no desbloqueada** (`caughtSpecies` en `encounters.ts`): desbloquea, `caught++` y suma la parte.
   - Con `threshold` conocido: `xp = min(threshold, xp + round(catchShare × threshold))`.
   - Sin él (una especie que nunca fue compañera no tiene línea cargada): `pendingShare = min(1, pendingShare + catchShare)`.
   - Solo la **primera** captura suma xp. Las siguientes son duplicados.
3. **Duplicado** (especie ya desbloqueada, por captura, eclosión o compañero): `caught++` y `earnedTokens += duplicateReward[encounter.rarity]`. Sin xp.
4. **Shiny salvaje capturado:** `shinyUnlocked = true`, sea nuevo o duplicado.
5. **Aplicar `pendingShare`** (`growth.ts`, `fix`): al fijar el `threshold`, `xp += round(pendingShare × threshold)` (con el mismo tope) y se borra `pendingShare`. Pasa cuando la especie entra en juego (eclosión, evolución, `setCompanion`).
6. **El medidor nunca va por detrás de la barra.** Ya en `applyUsage`, tras `fix`: si la especie en juego no está registrada, `usedAtStage = max(usedAtStage, min(xp, threshold))`. Sin esto, una especie capturada (5 %) que eclosiona o a la que se evoluciona empezaría el medidor en 0 con la barra al 5 %. Es la misma regla que ya aplica `setCompanion`.
7. **Porcentaje sin línea:** `registrationPercent` con `threshold` desconocido lee `floor(100 × pendingShare)`, así que la Pokédex muestra 5 % desde la captura.
8. **Resultado:** `TurnOutcome.caught` gana `registeredPercent?` (primera captura: el % tras sumar) y `reward?` (duplicado). `D.turnResultText` añade «Registrado al 5 %» o «Ya lo tenías: +2M tokens» (ko/en/ja/es). La webview no cambia: pinta `resultText`, y el chip de saldo ya anima la subida.

**Reparto:** núcleo (1–8) y tests, yo. @helper: fixture de bench con resultado de duplicado y de primera captura, y comprobar el texto a 280 px.

## Mejoras de UI (pedidas por Diego, 2026-10-20)

1. **Barra de EXP al estilo de los juegos.** La barra azul de la placa del jugador pasa a parecerse a la de los juegos: pista oscura con borde, etiqueta «EXP» a la izquierda y relleno azul. Lo que lleva y lo que le queda van integrados en la barra o junto a ella, del mismo azul (`--exp`), en vez de la línea suelta de `toNextText`.
   - El núcleo emite los textos ya formateados: `PanelCompanion.expText` («2,1M / 16,7M») y `expLeftText` («faltan 14,6M»), de `dispatch.ts`. La webview no calcula números.
   - Cualquier `?? Math.round(c.progress * 100)` que quede en la webview se sustituye por un campo del núcleo.
2. **Aviso de captura.** Al capturar sale un aviso en la zona del salvaje, como el de subir de nivel: «+5 % de registro» y «¡Nuevo en la Pokédex!», o «Ya lo tenías: +2M tokens».
   - El núcleo añade `PanelEncounterResult.catchNews` = `{ isNew, headline, detail }`, ya localizado (ko/en/ja/es).
   - La webview lo anima sobre la escena y respeta `prefers-reduced-motion`.
3. **Poké Ball en la tarjeta del salvaje.** Si ya tienes la especie, su placa muestra una Poké Ball pequeña junto al nombre, como en los juegos.
   - El núcleo emite `PanelWildEncounter.owned` y `ownedText` (tooltip/aria).
   - **Criterio:** *obtenido* (`unlocked`), que es lo que marca la Poké Ball en los juegos. Así cuenta también lo que tienes al 5 % por una captura, no solo lo registrado al 100 %. Se puede cambiar a «registrado» si Diego lo prefiere.

4. **Aviso de «Nuevo en la Pokédex» con su barra** (Diego): el Pokémon pasa de silueta a revelado y su barra de registro arranca en el estado previo. Luego aparece «+5 %», el tramo nuevo se rellena de blanco al 80 % y ese blanco se vuelve del color de EXP dentro de su hueco.
   - El núcleo manda `catchNews.registration = { speciesID, fromPercent, toPercent }`, calculado por `catchBanner` en `build.ts` con el estado leído antes del turno.
5. **Compañero terminado** (Diego): cuando la última forma de un compañero llena su barra y no le queda nada por registrar debajo (`companionIsDone`), por defecto pasa a ser compañero otra especie al azar entre las desbloqueadas sin registrar.
   - Si no queda ninguna, incuba un huevo del stock; si tampoco hay huevos, se queda.
   - Avisa con un toast (`companionSwitched`), siempre después de la celebración de la graduación.
   - Ajuste en Ajustes, `keepCompletedCompanion` (por defecto, cambiar): si está activado, se queda y los tokens esperan a la barra shiny de la fase 5.
   - Se guarda como el entrenador: cuenta como ajuste de esta máquina y en una fusión gana el lado local.

**Reparto:** los campos del núcleo, los textos y sus tests, yo. Webview (`main.ts`, `styles.css`) y bench, @helper.

## Notas de la implementación

- Simulador, 180 días, semillas 1–3 (medio): registradas 86/110/101 frente a 96/103/101 en la fase 2; desbloqueadas 110/146/130 frente a 132/136/132. La varianza entre semillas (101–140 desbloqueadas) es mayor que el efecto. Los duplicados sí se notan en la cartera del perfil medio con la semilla 1 (6,5B frente a 4,7B): refuerza la necesidad de sumideros de la fase 4.
- `growth.ts` aplica `pendingShare` en `fix` y pone el medidor al nivel de la barra (salvo Ditto disfrazado y especies registradas).
- Hallazgos de la revisión de código, corregidos con test e inyección:
  - La parte se redondea **hacia arriba** (`shareXP`): redondeando al más cercano, 9 de 24 combinaciones de rareza/formas/etapa leían 4 %.
  - La fusión descarta `pendingShare` si algún lado ya conoce el `threshold`: ese lado ya la convirtió en xp, y arrastrarla aplicaba la captura dos veces.
  - Al revelarse un Ditto, la especie del disfraz pierde el desbloqueo si solo lo tenía por la eclosión (sin capturas, sin xp, sin registro). Si no, su primera captura real contaba como duplicado.
  - El medidor se nivela con la barra en **cada** forma a la que llega el compañero (`settle` en `applyUsage`), también al evolucionar. La regla es `meterStart`, la misma que usa `setCompanion`.
  - Un shiny capturado marca `shinyUnlocked` (colección) pero no vuelve shiny al compañero criado. El shiny del compañero va en su propio campo, `companionShiny`, que escribe `retireCompanion`.
  - El texto en español usa `5%` como la fila de la Pokédex. El tipo del resultado de captura en `turnResultText` se deriva de `TurnOutcome`.

- Segunda revisión (mejoras de UI + compañero terminado), corregido con test e inyección:
  - El cambio automático es un paso en segundo plano: si otra ventana tiene el guardado, se salta (nunca lanza `SaveBusyError` al escaneo).
  - Prueba los candidatos en orden aleatorio y salta los que su línea no contiene; sin red, lo deja para el siguiente refresco. Sin especies, retoma el huevo en pausa o empieza uno del stock.
  - Una especie registrada elegida a mano no se cambia sola (`MonState.chosenWhenRegistered`, que se borra al evolucionar).
  - El detalle del aviso dice lo que suma esta captura (`toPercent − fromPercent`).
  - `expBar` usa `eggProgress`/`eggTokensToHatch` y `stageProgress`/`tokensToNext`, los mismos cálculos que la barra de estado.
  - Webview (@helper): el temporizador del aviso solo borra el suyo; el % del héroe no contradice su barra.
- Sin corregir, a conciencia:
  - Los guardados de antes de `companionShiny` solo marcaban `shinyUnlocked` al retirar un compañero shiny. No se migra porque la fase 2 no ha salido en ninguna versión: solo hay partidas de desarrollo.
  - La fusión hace OR de `unlocked`, así que una copia anterior a la revelación de un Ditto devuelve el desbloqueo del disfraz. Pasa solo si se sincroniza justo entre la eclosión y la revelación, y el coste es un duplicado pagado en vez de un 5 %. Se acepta frente a romper la regla «los estados solo se encienden».
  - `baseFromHistory` de una captura salvaje de forma evolucionada devuelve la propia forma. Es cosa de la 3b (anotado allí).

## Verificación

- `wild-encounters`: captura de especie nueva → 5 % y desbloqueo; duplicado → `earnedTokens` exactos de la tabla y sin xp extra (inyectar que sume xp dos veces); la recompensa queda estrictamente por debajo de la mitad del coste esperado de captura (test de balance derivado de `catchChance`); un duplicado con `spentTokens = 0` conserva la recompensa (inyectar la resta de `spentTokens` y ver que falla).
- `panel-build`: texto del resultado.
- Bench: el chip de saldo aparece tras una captura duplicada.
