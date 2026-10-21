# Fase 1 — Núcleo de registro por especie

**Plan maestro:** `00-master.md` § Fase 1. Hereda las decisiones de la tabla del maestro y las conclusiones C1 (escala), C2 (partida real), C3 (÷15), C4 (Caramelo Raro).
**Estado:** implementado en `feat/species-registry` (2026-10-20). Diferencias respecto al borrador, por lo que enseñó el código:

- La siembra de la migración corre **al final** del decodificador, después de colocar el compañero: colocada antes, el `active` decodido después recuperaba su progreso (378M frente a 33M) y se graduaba en el primer fold. Lo destapó la partida real, no la suite; ahora lo fija `companion-model`.
- El crédito en bruto a la especie (`creditSpeciesXP`, en `registry.ts`) lo hace **`creditDelta`** (`ledger.ts`), el único sitio que sabe si el delta fue al huevo o al compañero; la revisión encontró que las dos copias a mano (fold y fusión) ya habían divergido: la fusión construía el registro fusionado desde el mapa anterior al crédito y lo perdía. Ahora hay un test que lo fija.
- `applyUsage` recibe el conjunto de especies desbloqueadas (`ReadonlySet<number>`) en lugar de `collectedFinals`, y el mapa `species`; devuelve el mapa actualizado. `graduate()` sigue escribiendo `collectedFinals` por compatibilidad, pero ya nadie lo lee para decidir.
- Candy: `candyRoomLeft(state)` en `shop.ts` es la única comprobación del tope; el store aplica `rareCandyXP(active)`.
- Capturar ya desbloquea la especie y cuenta `caught` (sin el 5 %, que es de la fase 3): si no, una captura anterior a la migración leía como obtenida y una posterior no. El sorteo de salvajes mantiene además el sesgo sobre las capturas `wild` del `dex`.
- Revisión de código (10 hallazgos): arreglados la fusión, `species: null` (ahora siembra), las entradas vacías del mapa (se descartan), el Ditto (mueve solo la xp de esta vida) y la copia del mapa en cada fold (copy-on-write). Descartados por diseño: reexpresar los precios de la tienda en función de la escala (fase 4) y los campos reservados (`earnedTokens`, shiny, `pendingShare`) que las fases 3 y 5 escriben.
**Depende de:** fase 0 (commits).

## Objetivo

Que el progreso viva **por especie** y no en un único `MonState`: un mapa `species` en `CompanionState` con la experiencia, el estado (visto, desbloqueado, registrado) y los caramelos de cada especie, y la escala nueva. Sin interfaz nueva todavía: al terminar esta fase el juego se ve igual, pero los datos ya están.

## Alcance

- `model.ts`: `SpeciesProgress` (con `registered`, `threshold`, `lineRarity`, `candiesUsed`), `species: Record<number, SpeciesProgress>`, `earnedTokens`, `graduationTotal` ÷ 15, `RareCandy.stageShare = 0.25` y `maxPerSpecies = 2`. `COMPANION_STATE_SCHEMA` no cambia.
- `registry.ts` (nuevo, puro): `registerXP(speciesID, line)`, `creditSpeciesXP`, `registrationPercent`, `seedRegistry` (migración) y `rareCandyXP`.
- `persistence.ts`: decodificación entrada a entrada (enteros; `isNumberRecord` descarta el mapa entero si hay un flotante, así que no se usa para esto).
- `saveTransfer.ts`: `sanitized` acota `xp`, `shinyXP`, `caught`, `candiesUsed` y `pendingShare` (0..1) por clave, y `earnedTokens`.
- `ledger.ts`: `spendableBalance = used + earned − spent`; `stealAmount` y `trackLegendary` (`encounters.ts`) dejan de calcular el monedero inline y usan `spendableBalance` (test que lo fije).
- `merge.ts`: `xp`/`shinyXP` del ganador + crédito de la fusión; `seen`/`unlocked`/`registered`/`shiny*` en OR; `caught`/`candiesUsed`/`threshold` por máximo; `earnedTokens` del ganador. Ver "Sincronización" en el maestro.
- `growth.ts` (`applyUsage`): acredita `species[actual].xp` paso a paso en el bucle (llena hasta `threshold`, arrastra el sobrante a la forma siguiente) y marca `registered`. **Sin línea** (`line === undefined`, hoy devuelve pronto): la xp acumula en bruto, el porcentaje se acota a 100 % y no se marca `registered`; al recargar la línea, `grow(0)` fija `threshold` y resuelve. `store.ts` pasa de `creditDelta` + `grow(0)` a `grow(delta)`; `creditDelta` deja de escribir `active` y queda para huevo y saldo. El caramelo entra por `grow`. `revealedDitto` mueve la xp a `species[132]`.
- `store.ts`: `rollEncounter` marca *visto*. Los lectores de `collectedFinals` (`pickPlannedChild`, `makeEvolutionPlan`, `normalizedEvolutionState` en `growth.ts`; `chooseBaseFromIndex` en `pokeapi.ts`) pasan a un `ReadonlySet<number>` de especies desbloqueadas; `collectedFinals` se mantiene en el save sin escribirse.
- `shop.ts`: `canUseRareCandy`/`consumeRareCandy` con el tope por especie; `applyCandy` usa `rareCandyXP`; un caramelo sobre una especie registrada no hace nada (nunca alimenta la barra shiny).
- `dispatch.ts`: descripción del caramelo (hoy dice "100M") y pista de la bolsa cuando el Pokémon está lleno.

## Fuera de alcance

Elegir compañero, inicial, evolución por barra (fase 2); captura = registro (fase 3); interfaz de la Pokédex (fase 2).

## Migración (C2)

**Todo al 0 %** (decisión de Diego). Al leer una partida sin la clave `species`, `seedRegistry` siembra:

- cada forma de `dex` (`chainOrder` de las líneas graduadas y las capturas `wild`) y de `collectedFinals` → `unlocked: true`, xp 0;
- el compañero actual: todas las formas de `pathIDs` → `unlocked: true`, xp 0; `usedAtStage` → 0.

Solo flags y ceros: ningún umbral, así que es síncrono y sin red; `threshold` y `lineRarity` se fijan la primera vez que la especie recibe xp o se carga su línea. Solo si falta la clave, como `milestonesAwarded`: nunca retroactivo, ni shiny retroactiva. Sin cambio de esquema: `usedAtStage` se reinicia en la misma siembra.

## Preguntas abiertas

- Resuelto: `threshold?` y `lineRarity?` son opcionales; se fijan cuando la línea está cargada (al desbloquear, al recibir xp o al recargar). Hasta entonces la xp acumula en bruto, el porcentaje se acota a 100 % y nunca se marca `registered`; `pendingShare?` guarda un % debido (capturas sin red) y se aplica al fijar `threshold`. Fusión: el definido cuando solo un lado lo tiene; `pendingShare` por máximo.
- Una especie en varias líneas (Eevee → 8) tiene una sola posición: etapa 2 de 2. OK.
- Resuelto: `collectedFinals` se mantiene en el save y deja de escribirse; sus lectores cambian en esta fase (ver Alcance).

## Verificación

- `test/companion-registry.test.ts` (nuevo): `registerXP` por rareza y etapa, migración (todo desbloqueado al 0 %, `usedAtStage` a 0), sin siembra cuando la clave existe, decodificación tolerante, acotado.
- `companion-merge`: crédito de fusión sin doble conteo (inyectar "máximo por clave" y ver que falla); una especie registrada solo en el perdedor sigue registrada tras la fusión.
- `companion-growth`: el sobrante arrastra a la forma siguiente y la anterior queda exactamente en `threshold` (inyectar el crédito en bloque y ver que falla); diversidad de ramas con el conjunto de desbloqueadas.
- `companion-shop`, `companion-store`: caramelo relativo y tope (inyectar `<=` y ver que falla).
- Actualizar tests que fijan cifras: `companion-growth`, `companion-model`, `companion-store`, `dev-simulation`, `i18n` y `panel-build` ("100M").
- Migración real: copia de la partida de Diego en `.dev-state`, comprobar que las 45 especies quedan desbloqueadas al 0 %, que Gyarados sigue de compañero al 0 % y que el saldo y el historial no cambian.
- `make check` y `make e2e`.
