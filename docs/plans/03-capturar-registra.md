# Fase 3 — Capturar = registrar

**Plan maestro:** `00-master.md` § Fase 3. Hereda "captura 5 %", "duplicado da tokens" y las reglas anti-abuso de C6.
**Estado:** borrador. Se detalla en modo plan justo antes de implementar.
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

## Verificación

- `wild-encounters`: captura de especie nueva → 5 % y desbloqueo; duplicado → `earnedTokens` exactos de la tabla y sin xp extra (inyectar que sume xp dos veces); la recompensa queda estrictamente por debajo de la mitad del coste esperado de captura (test de balance derivado de `catchChance`); un duplicado con `spentTokens = 0` conserva la recompensa (inyectar la resta de `spentTokens` y ver que falla).
- `panel-build`: texto del resultado.
- Bench: el chip de saldo aparece tras una captura duplicada.
