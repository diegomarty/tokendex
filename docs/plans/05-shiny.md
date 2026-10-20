# Fase 5 — Shiny por experiencia y Shinydex

**Plan maestro:** `00-master.md` § Fase 5 y C5. Hereda "una sola barra `8 × registerXP`, impulso opcional hasta la mitad, captura/eclosión shiny completa la barra".
**Estado:** borrador. Se detalla en modo plan justo antes de implementar.
**Depende de:** fase 2 (compañero a elección), fase 1b (simulador parametrizado para fijar el tope del impulso).

## Objetivo

Que cualquier especie registrada pueda tener su forma shiny registrada, con un camino largo (experiencia como compañero) y un atajo parcial (impulso con tokens), y que la Shinydex sea el prestigio a largo plazo.

## Diseño inicial

- `SpeciesProgress.shinyXP` y `shinyUnlocked` (ya reservados en la fase 1).
- `growth.ts`: con la especie registrada y sin ramas pendientes, la xp va a `shinyXP`; al llegar a `8 × graduationTotal(lineRarity)` (por forma, no por etapa) → `shinyRegistered`. El caramelo nunca entra aquí.
- Capturar un salvaje shiny o eclosionar uno shiny → `shinyUnlocked` (la fase 3 lo marca) y la barra queda completa (`shinyRegistered`).
- **Impulso shiny:** acción `boostShiny(speciesID, tokens)` que cobra a `spentTokens` y suma `shinyXP` 1:1 hasta el 50 % del requisito (`EconomyBalance.shinyBoostShare`). Patrón de extremo a extremo igual que `setCompanion`, con modal nativo de confirmación como las compras.
- "Vestir" la shiny: `active.isShiny` pasa a ser elegible cuando `shinyUnlocked` (hoy es un sorteo fijo al nacer). Compatibilidad: un compañero nacido shiny por sorteo conserva `isShiny`.
- Pokédex: segmento **Shinydex** (shinies registradas / 649), eje `shiny` en las celdas, barra shiny en el detalle, botón de impulso.
- `dev/scenarios.ts`: "desbloquear la shiny".

## Preguntas abiertas

- Amuleto Iris: hoy 1/64 → 1/48 en salvajes y eclosiones. ¿También descuenta el impulso o acelera `shinyXP` (p. ej. ×1,25)? A decidir con el simulador en la fase 4.
- ¿La shiny de una forma intermedia (Charmander) exige la forma final registrada? No: cada especie es independiente.

## Verificación

- `companion-growth`: orden ramas → shiny; umbral exacto `8 × graduationTotal(lineRarity)` (inyectar 8 × umbral de etapa y ver que falla con Charmander).
- `companion-store`: el impulso nunca supera el 50 % (inyectar `<=`), cobra exactamente lo sumado y rechaza sin saldo.
- `companion-merge`: `shinyUnlocked` en OR; `shinyXP` del ganador.
- Bench: Shinydex y detalle con barra shiny.
