# Fase 5 — Shiny por experiencia y Shinydex

**Plan maestro:** `00-master.md` § Fase 5 y C5. Hereda "una sola barra `8 × registerXP`, impulso opcional hasta la mitad, captura/eclosión shiny completa la barra".
**Estado:** detallado (2026-10-21), en implementación.
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

## Diseño detallado (tras las fases 2–4)

1. **Requisito por forma.** `shinyTarget(lineRarity) = 8 × graduationTotal(lineRarity)`, en `registry.ts`: común 400M, poco común 1B, rara 1,6B, legendaria 3,2B. Necesita `lineRarity`, que ya se fija con el `threshold`; sin ella la barra shiny no avanza.
2. **De dónde sale la experiencia shiny** (`growth.ts`). El compañero registrado que se queda parado (hoja registrada, o especie registrada sin nada que registrar debajo) ya no acumula xp por encima del umbral: el excedente pasa a `shinyXP`, con tope en el requisito. Al llegar:
   - se marcan `shinyRegistered` y `shinyUnlocked`;
   - el compañero pasa a ser shiny (`isShiny`, y al retirarse `companionShiny`);
   - evento `shinyRegistered` con su aviso.

   El caramelo nunca entra aquí: su xp es de etapa.
3. **Encaje con el compañero terminado.** Por defecto (`keepCompletedCompanion` desactivado), el compañero terminado pasa a otra especie, así que la barra shiny solo avanza si Diego lo elige:
   - activando «mantener al compañero» en Ajustes;
   - o eligiendo a mano una especie registrada (`chosenWhenRegistered`).

   Ese es el sentido del ajuste. Con la shiny ya registrada, el compañero cuenta como terminado también para el ajuste: si está activado, se queda, y los tokens sobrantes no van a ningún sitio.
4. **Shiny capturado o eclosionado.** Captura (fase 3, `caughtSpecies`) o eclosión de un shiny → `shinyUnlocked` y `shinyRegistered`: la barra queda completa, y `shinyXP` = requisito si se conoce.
5. **Impulso** (`boostShiny(speciesID, amount)`, puro en `shop.ts`, más acción del store, del worker y de la extensión).
   - Requiere la especie registrada, con `lineRarity`, y su shiny sin registrar.
   - Cobra en `spentTokens` y suma 1:1 a `shinyXP` y a `shinyBoosted`, campo nuevo que lleva la cuenta de lo comprado.
   - Tope: `shinyBoostShare × requisito − shinyBoosted`, sin pasar de lo que falta ni del saldo.
   - El núcleo ofrece dos importes ya formateados en el detalle de la Pokédex: +10 % del requisito y el máximo posible. La compra pide confirmación nativa como las demás.
6. **Persistencia.**
   - `shinyBoosted` se decodifica y se acota.
   - En la fusión, máximo de `shinyXP` y `shinyBoosted`; `shinyRegistered` y `shinyUnlocked` en OR.
7. **Panel** (núcleo, con UI de @helper):
   - `PanelDexSpecies.shiny` = { percent, text, boost?: [{ id, text, priceText, label }] };
   - `dexSummary` gana el recuento de la Shinydex (registradas / 649) y el texto de su segmento.
8. **Amuleto Iris:** sin cambios en esta fase (1/64 → 1/48 en salvajes y eclosiones). Si acelera `shinyXP` se decide con el simulador después.
9. **Simulador:** el perfil intenso, con todo lo desbloqueado registrado, mantiene compañeros registrados para su shiny e impulsa con el saldo que le sobra. Se mide qué parte de lo que gana gasta (objetivo de C6: 40–70 %).
10. **Dev:** escenario «desbloquear la shiny».

**Reparto:** núcleo, persistencia, store, worker, extensión, textos, simulador y tests, yo. Webview (segmento Shinydex, barra shiny y botones de impulso en el detalle) y bench, @helper.

## Notas de la implementación

- `shinyTarget` y `obtainShiny` viven en `registry.ts`. `growth.ts` manda el excedente de una especie registrada y parada a `shinyXP` en las dos ramas de parada (hoja, o nada por registrar debajo). Antes, ese excedente se perdía.
- La fusión toma el máximo de `shinyXP` y `shinyBoosted`. Antes se quedaba el `shinyXP` del lado base e ignoraba el del otro.
- Impulso: `shinyBoostRoom` / `shinyBoostOffers` / `boostShiny` en `shop.ts`, `CompanionStore.boostShiny` en un solo bloqueo, y la extensión pide confirmación con modal nativo.
- Panel: `PanelDexSpecies.shinyBar` (porcentaje, texto, impulsos y motivo si no se puede) y `dexSummary` con los campos de la Shinydex (`shinyRegistered`, `shinyPercent`, `shinyProgressText`, `shinySegmentText`). La UI es de @helper: segmento Shinydex, barra dorada `.game-meter` y botones LCD de la tienda.
- **Simulador** (180 días, semillas 1–2). Política: cuando no queda nada por registrar, mantiene al compañero, e impulsa barras shiny con lo que pasa de 1B de reserva.
  - intenso: gasta el 99–100 % de lo que gana (antes 17 %), 70–86 shinies;
  - medio: 95–96 % (antes 50–56 %), 22–26 shinies;
  - ligero y chat: sin cambios.

  El 100 % lo pone la política, que gasta todo lo que pasa de la reserva, no el juego. Lo que prueba es que el sumidero da para absorber el saldo sobrante del intenso, que era el objetivo de la fase 4.
- Dev: escenario `register-shiny`.
- Revisión de código, corregido con test e inyección. Una sola vía para registrar una shiny, `registerShiny(state, id)`: marca la shiny y viste al compañero si es esa especie y no es un Ditto disfrazado. La usan la captura, el impulso, la eclosión y el atajo de desarrollo.
  - Un Ditto shiny disfrazado ya no registra la shiny de la especie que imita; la registra como Ditto al revelarse.
  - Capturar un shiny de la especie del compañero lo viste, como el impulso y el juego.
  - Una shiny registrada antes que su especie tiene su barra al 100 % en la Shinydex.
  - El impulso abre la ventana de celebración y nombra la especie igual que el crecimiento (`speciesName`).
  - El tope del impulso se escribe una vez (`shinyBoostCapLeft`), y el texto lleva el porcentaje en vez de «la mitad».
  - El simulador usa `currentSpeciesID` y **ahora entra en el typecheck** (`tsconfig.json`). Fuera, tenía tres errores escondidos: un import que faltaba, una compra sin comprobar y un `await` de primer nivel.

## Preguntas abiertas

- Amuleto Iris: hoy 1/64 → 1/48 en salvajes y eclosiones. ¿También descuenta el impulso o acelera `shinyXP` (p. ej. ×1,25)? A decidir con el simulador en la fase 4.
- ¿La shiny de una forma intermedia (Charmander) exige la forma final registrada? No: cada especie es independiente.

## Verificación

- `companion-growth`: orden ramas → shiny; umbral exacto `8 × graduationTotal(lineRarity)` (inyectar 8 × umbral de etapa y ver que falla con Charmander).
- `companion-store`: el impulso nunca supera el 50 % (inyectar `<=`), cobra exactamente lo sumado y rechaza sin saldo.
- `companion-merge`: `shinyUnlocked` en OR; `shinyXP` del ganador.
- Bench: Shinydex y detalle con barra shiny.
