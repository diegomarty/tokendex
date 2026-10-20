# Fase 3b — Salvajes con formas evolucionadas

**Plan maestro:** `00-master.md` § Fase 3b. Hereda la decisión "sí, con peso reducido: 65/30/5 y 75/25, con incentivo a lo que no tienes".
**Estado:** borrador. Se detalla en modo plan justo antes de implementar.
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

## Preguntas abiertas

- ¿Afecta a los legendarios debidos (`owedLegendaryEncounters`)? No: son líneas de una forma.
- ¿La cola conserva las apariciones viejas? Sí; nada cambia en lo ya en cola.
- Tamaño del índice con cadenas: ~328 líneas × hasta 8 ids; trivial.

## Verificación

- `pokeapi`: distribución 65/30/5 con un `rng` fijo (inyectar 50/50 y ver que falla); ramas uniformes; incentivo por estado.
- `companion-store`: una línea de 3 etapas produce etapas distintas a lo largo de N apariciones; sin red el sorteo sigue funcionando con el índice en disco.
- Simulador: tiempo para desbloquear toda la Pokédex capturando (objetivo 4–8B, C6).
