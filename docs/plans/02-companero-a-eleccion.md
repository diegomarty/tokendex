# Fase 2 — Compañero a elección, inicial y huevo diario

**Plan maestro:** `00-master.md` § Fase 2 y "Modelo objetivo". Hereda "elegir inicial", "registra y evoluciona", "ramas pendientes, luego shiny" y "un huevo gratuito al día, acumulables hasta 3".
**Estado:** implementado en `feat/species-registry` (2026-10-20). Notas de la implementación al final.
**Depende de:** fase 1 (mapa `species`), fase 1b (cifras).

## Objetivo

El jugador elige su compañero entre las especies desbloqueadas o incuba un huevo del stock diario; completar la barra registra la especie y evoluciona; la Pokédex muestra los estados; el primer arranque pide un inicial.

## Diseño, tal como se implementa

### Modelo (`model.ts`, `registry.ts`)

- `MonState` **se conserva** como "el compañero en juego" (ruta, plan de ramas, etapa, progreso de etapa). Reescribirlo era la opción del borrador; sobre el código real cuesta más de lo que aporta: `growth.ts`, el store, el panel y la barra de estado viven de él. Lo que cambia es **cómo nace**: además de la eclosión, `setCompanion` lo construye desde la línea de la especie elegida.
- `SpeciesProgress` gana la **posición en la línea** cuando se fija el umbral: `baseID`, `stageIndex`, `totalForms`. Es lo que permite reconstruir un `MonState` sin adivinar: la base para pedir la línea y la etapa para el umbral. Las especies sembradas desde `dex` lo reciben de `chainOrder`; las capturadas, de sí mismas (son bases hasta la fase 3b).
- `eggStock: { count, lastGrantDay? }` (0..3). `eggUsage`/`eggTier`/`pendingHatchID` se quedan como están y **pasan a poder convivir con `active`**: un huevo en pausa es un huevo con uso y garantía mientras hay compañero. `sanitized` deja de borrarlos.
- `STARTERS` (ids 1, 4, 7, 152, 155, 158, 252, 255, 258, 387, 390, 393, 495, 498, 501).

### Crecimiento (`growth.ts`)

- Una especie **registrada en su forma final** se queda: la barra llena, sin graduación, sin huevo nuevo. El evento `graduated` y la entrada en `dex` se emiten **una sola vez** (cuando pasa de no registrada a registrada), como historial y celebración.
- Una especie registrada **con ramas pendientes** (algún hijo con una especie sin registrar en su subárbol) sigue evolucionando al llenar la barra; sin ramas pendientes se queda (la xp sobrante es de la fase 5).
- `fix` guarda `baseID`/`stageIndex`/`totalForms` en la especie.

### Store (`store.ts`)

- `setCompanion(speciesID)`: rechaza si no está desbloqueada; pide la línea de su base (`provider.line`), construye la ruta base → especie en el árbol, el plan con `makeEvolutionPlan`, `usedAtStage = min(xp, umbral)`, una naturaleza al azar, y lo confirma bajo el lock. Cambiar es gratis y sin límite.
- `chooseStarter(speciesID)`: solo con el mapa `species` vacío, sin `active` y sin huevo en curso; desbloquea y llama a `setCompanion`.
- `incubateEgg()`: con un huevo en pausa, lo retoma (`active` fuera, sin consumir stock); si no, exige `eggStock.count > 0`, descuenta uno y empieza a incubar. El compañero apartado no pierde nada: su progreso está en `species`.
- El huevo diario se concede junto a `noteAccrualDay`, con `observation.todayDate` y dentro de `delta > 0`.
- `graduate()` ya no borra `active` ni pone `eggUsage` a 0.
- Tienda: `buyEgg(tier)` exige un huevo incubando y le escribe la garantía; no descarta nada.

### Persistencia y fusión

- `eggStock`: `count` entero 0..3, `lastGrantDay` con forma de día; clave ausente → `{ count: 0 }` sin regalar días pasados. Fusión fail-closed: `count` del ganador, `lastGrantDay` el más reciente.
- `baseID`/`stageIndex`/`totalForms` de la especie: enteros; en la fusión, el definido cuando solo un lado lo tiene.

### Host, worker y panel

- Acciones `setCompanion`, `chooseStarter`, `incubateEgg` de extremo a extremo (`protocol.ts` → `main.ts` → `surface.ts` → `extension.ts` con guarda propia: entero 1–649 → `scanWorker.ts` → store). Las tres entran en `CHANGING_REQUESTS`.
- Contrato del panel (ya escrito en `protocol.ts`): `PanelDexSpecies` con `status`, `shiny`, `percent`, `percentText`, `canChoose`, `isCompanion`; `PanelCompanion.registrationPercent`; `PanelState.starters` (solo en el primer arranque) y `PanelState.eggs`.
- Webview: pantalla de inicial; en la Pokédex, estados por celda y botón «Elegir como compañero»; stock de huevos y botón de incubar; placa del jugador con el % de registro. Barra de estado (`snapshot.ts`): el % en el tooltip.

### Dev

`dev/scenarios.ts`: "dar xp a la especie en juego", "registrar al instante", "marcar vista", "dar un huevo al stock".

## Preguntas abiertas

- Las partidas existentes no ven la pantalla de inicial (ya tienen compañero).
- Una especie _vista_ no tiene nombre guardado; la Pokédex la muestra por número hasta que se desbloquea. Guardar el nombre al verla queda para cuando haya nombres offline.

## Notas de la implementación

- `eggs.ts` (puro): `grantDailyEgg`, `incubateEgg`, `eggIsPaused`, `canIncubate`. Un huevo cuenta como *en pausa* si tiene uso, pre-sorteo **o garantía pagada**: empezar uno nuevo lo perdería.
- `graduated` sigue existiendo como evento y entrada en `dex`, pero una sola vez por especie; `graduate()` ya no borra `active`.
- El simulador registra menos especies con estas reglas (medio 94 frente a 130 en 180 días) porque desaparece el huevo gratis tras cada graduación; ver `01b`.
- `isFreshGame`, `eggHasProgress`, `eggOnStage`, `eggIsPaused` y `setEggAside` viven en `eggs.ts` (puro, sin `node:fs`): una sola definición para el panel, el store, el ledger y la tienda. Partida nueva = nada **desbloqueado** (una especie solo *vista* no cuenta: los salvajes aparecen también antes del inicial), sin compañero y sin progreso de huevo (uso, pre-sorteo o garantía).
- Hallazgos de la revisión de código, corregidos con test e inyección:
  - En partida nueva el uso es solo saldo (`creditDelta`): antes iba al huevo, y el primer refresco con uso real cerraba la pantalla de inicial y eclosionaba un huevo al azar. La barra de estado muestra «Elige tu primer Pokémon» en vez de una cuenta atrás.
  - `chooseStarter` es atómico: pide la línea y después desbloquea y pone el compañero en un solo bloqueo. Si falla sin red, la partida sigue siendo nueva.
  - Un huevo sacado del stock que se aparta sin progreso vuelve al stock (`setEggAside`).
  - El compañero que se retira guarda su naturaleza y su shiny en el registro (`SpeciesProgress.nature`, `shinyUnlocked`; `retireCompanion`), y vuelve igual al elegirlo otra vez. Pasa al cambiar de compañero y al incubar.
  - Las garantías de huevo no se venden antes del inicial (`eggOnStage`).
  - Una especie registrada que evoluciona solo va hacia una rama con algo sin registrar: si el plan apunta a una rama ya registrada entera, se redirige.
  - Los recuentos de la Pokédex los emite el core (`PanelState.dexSummary`, @helper); la webview ya no filtra `dexSpecies`.
- Los tests del store parten de una partida ya empezada (`tempFile()` con #999 desbloqueada); los de inicial usan `freshFile()`.

## Verificación

- `companion-growth`: registrada en forma final se queda y no gradúa dos veces (inyectar la segunda graduación); ramas pendientes antes de quedarse.
- `companion-store`: `setCompanion` rechaza no desbloqueadas (fail closed) y reconstruye la etapa correcta; `chooseStarter` solo en partida nueva; el huevo diario se concede una vez por día y nunca pasa de 3 (inyectar `<=`); incubar sin stock se rechaza; retomar un huevo en pausa no consume stock; `buyEgg` sin huevo incubando se rechaza (inyectar el descarte).
- `companion-model`, `save-transfer`, `companion-merge`: decodificación, acotado y fusión de `eggStock` y de la posición en la línea.
- `panel-build`: estados, porcentajes, `starters` solo en partida nueva, `eggs`.
- Bench: Pokédex, elección de compañero, inicial, stock de huevos en claro/oscuro, 280–600 px; e2e; prueba manual con `make dev`.
