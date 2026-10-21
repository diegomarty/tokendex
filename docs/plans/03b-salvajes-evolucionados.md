# Fase 3b — Salvajes con formas evolucionadas

**Plan maestro:** `00-master.md` § Fase 3b. Hereda la decisión "sí, con peso reducido: 65/30/5 y 75/25, con incentivo a lo que no tienes".
**Estado:** detallado (2026-10-20). Se implementa tras el commit de la fase 3.
**Depende de:** fase 3 (captura = registro), fase 1b (simulador para calibrar el incentivo).

## Objetivo

Que en estado salvaje aparezca cualquier forma, no solo inicios de línea, con la frecuencia de los juegos, y que el sorteo favorezca lo que el jugador aún no tiene.

## Situación hoy

`baseSpeciesIndex` (GraphQL, `evolves_from IS NULL`, id ≤ 649, sin Ditto) solo contiene inicios de línea; `chooseBaseFromIndex` pondera por `captureRate`, a la mitad si `${id}:` está en el conjunto visto. `rollEncounter` pide `wildSpecies(id)` (especie + stats + tipos).

## Diseño inicial

1. Sortear la **línea** como hoy (índice de bases, con incentivo).
2. Sortear la **etapa**: 65/30/5 (3 etapas), 75/25 (2), 100 (1). Con ramas en una etapa (Eevee), uniforme entre ellas favoreciendo las no desbloqueadas.
3. Para conocer la cadena hace falta `EvoLine` de esa base. Opciones: (a) ampliar el índice en disco con la cadena (una vez, `INDEX_SCHEMA` 3, cacheable 30 días); (b) pedir `line(baseID)` al aparecer (ya está cacheada en memoria por `PokeAPIClient.line`). Propuesta: (a), porque el sorteo debe funcionar sin red.
4. **Incentivo:** peso × 2 para especies sin desbloquear, × 1 desbloqueadas, × 0,5 registradas (hoy solo se halva lo capturado). Calibrar con el simulador: capturar un Charizard al 5 % evita 25M de xp de la etapa final (escala nueva), así que la rareza de que aparezca debe pagar eso.
5. `captureRate` de la forma evolucionada: PokéAPI lo da por especie y se usa el real para la **rareza del encuentro** (captura, caducidad, robos), como hoy. El registro y los duplicados usan la **rareza de la línea** (`lineRarity`), que ya viene en el índice ampliado.

## Diseño detallado

1. **Índice v3 con las formas de cada línea** (`pokeapi.ts`, `INDEX_SCHEMA = 3`).
   - Una sola consulta GraphQL más para todas las especies `id ≤ 649`: `id capture_rate evolves_from_species_id evolution_chain_id`.
   - Con ella, cada `BaseSpecies` gana `forms?: { id, stage, captureRate }[]` (sin la base; `stage` = profundidad desde la base). Se guarda en disco con el índice (30 días).
   - El fallback REST sigue construyendo solo bases. Sin `forms`, la etapa es siempre la base y nada se rompe.
   - Un índice v2 en disco se trata como caducado (como hoy con v1). Sin red, sigue valiendo y aparecen solo bases.
2. **Sorteo de la línea** (`chooseBaseFromIndex`, solo para salvajes; las eclosiones no cambian). Peso de la línea = `captureRate` × incentivo:
   - ×2 si alguna forma de la línea no está desbloqueada;
   - ×1 si todas están desbloqueadas pero alguna no está registrada;
   - ×0,5 si toda la línea está registrada.

   Sustituye al «la mitad si vista». El conjunto local de vistas/en cola de `rollEncounter` sigue restando peso para no repetir lo que ya espera en la cola.
3. **Sorteo de la etapa** (`pickWildStage`, puro, en `encounters.ts`):
   - profundidad 1: 100 %; profundidad 2: 75/25; profundidad 3: 65/30/5;
   - si una etapa tiene ramas (Eevee), se elige entre ellas con el mismo incentivo ×2/×1/×0,5 por forma;
   - para la cola, una forma ya en cola cuenta como desbloqueada.
4. **Rarezas.**
   - El **encuentro** usa el `captureRate` real de la forma (captura, caducidad, robos, huida), como hoy: `wildSpecies(formID)`.
   - El **registro** y el **duplicado** usan la rareza de la **línea**: `WildEncounter.lineRarity` (de la base). `caughtSpecies` paga `duplicateReward[lineRarity ?? rarity]`.
   - La persistencia y la transferencia aceptan `lineRarity` opcional, y las apariciones viejas sin él se leen como hoy.
5. **Legendarios debidos y huevos:** sin cambios. Son líneas de una forma, o eclosiones de bases.
6. **Simulador:** misma política. Medir cuánto tarda en desbloquearse la Pokédex capturando y cuánto aporta el 5 % de las formas finales. Objetivo de C6: 4–8B para tenerlo todo desbloqueado.

**Reparto:** núcleo, índice, simulador y tests, yo. @helper: bench del panel con un salvaje evolucionado (placa, terreno, Poké Ball) y comprobar que los nombres y sprites de formas no base se ven bien.

7. **Base y rareza de una forma capturada:** al capturar una forma evolucionada se guardan `baseID`, `stageIndex`, `totalForms` y `lineRarity` en su registro (desde el índice v3). Así `setCompanion` y el cambio automático piden la línea por la base real y con la rareza de la línea, no la de la forma. Hoy `baseFromHistory` cae en la propia forma (revisión de la fase 3).

## Preguntas abiertas

- ¿Afecta a los legendarios debidos (`owedLegendaryEncounters`)? No: son líneas de una forma.
- ¿La cola conserva las apariciones viejas? Sí; nada cambia en lo ya en cola.
- Tamaño del índice con cadenas: ~328 líneas × hasta 8 ids; trivial.

## Verificación

- `pokeapi`: distribución 65/30/5 con un `rng` fijo (inyectar 50/50 y ver que falla); ramas uniformes; incentivo por estado.
- `companion-store`: una línea de 3 etapas produce etapas distintas a lo largo de N apariciones; sin red el sorteo sigue funcionando con el índice en disco.
- Simulador: tiempo para desbloquear toda la Pokédex capturando (objetivo 4–8B, C6).
