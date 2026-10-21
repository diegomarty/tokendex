# Fase 6 — Señuelo (apuntar a una especie)

**Plan maestro:** `00-master.md` § Fase 6. Hereda C6 (sumideros) y la fase 3b (sorteo por etapa).
**Estado:** detallado (2026-10-21). Se implementa tras el commit de la fase 5.
**Depende de:** fase 3b (para apuntar a cualquier forma), fase 1b (simulador parametrizado para el precio).

## Objetivo

Que el jugador pueda elegir una especie *vista* o *desconocida* y aumentar su probabilidad de aparecer, pagando.

## Diseño inicial

- `CompanionState.lure?: { speciesID, until }`.
- Sorteo (fase 3b): la línea de la especie objetivo recibe peso × N (propuesta × 8), y dentro de la línea la etapa objetivo recibe el 60 % en lugar de su cuota.
- Coste: `EconomyBalance.lure` — propuesta un objeto de tienda "Incienso" por tiempo (24 h) con precio por rareza de la especie objetivo (p. ej. 20M / 50M / 100M / 300M), o un pago por aparición. Lo decide el simulador.
- Acción `setLure(speciesID)` de extremo a extremo, con confirmación nativa (es una compra).
- Pokédex: botón «Atraer» en especies no desbloqueadas; la cabecera de Inicio muestra el señuelo activo y su tiempo restante.
- Sincronización: `lure` viene del ganador, como `wild`.

## Diseño detallado

1. **A qué se puede apuntar:** a una especie **vista** (ya apareció en estado salvaje) y no desbloqueada, de una línea no legendaria. Haberla visto es lo que da su entrada en la Pokédex, y con ella su línea y su rareza: sin verla no hay precio ni posición. Los legendarios tienen su propio camino (hitos, racha, rastro).
   - `markSeen` guarda ahora, cuando el encuentro trae `line` (fase 3b), la posición y la rareza de la línea (`baseID`, `stageIndex`, `totalForms`, `lineRarity`) sin desbloquear. Así la Pokédex conoce la rareza de lo visto.
2. **Estado:** `CompanionState.lure?: { speciesID, baseID, stageIndex, until }`. Un solo señuelo a la vez; comprar otro sustituye al activo (la confirmación lo dice).
3. **Efecto en el sorteo** (`chooseWildFromIndex`):
   - la línea objetivo pesa ×8 sobre su peso normal;
   - dentro de ella, la etapa objetivo se lleva el 60 % y el resto se reparte el 40 % en proporción a sus cuotas;
   - entre ramas de esa etapa, gana la especie objetivo.

   No genera apariciones extra: solo cambia el sorteo de las que tocan. Con la cola llena, no hace nada.
4. **Duración y fin:** 24 h (`EconomyBalance.lure.durationMs`). Se acaba al llegar `until` o al **capturar** la especie objetivo. No se devuelve nada: el señuelo se consume.
5. **Precio por rareza de la línea** (`EconomyBalance.lure.price`): común 20M, poco común 50M, rara 150M. Propuesta inicial que fija el simulador. Regla del test: sale más barato que esperar a que aparezca la especie sin señuelo y capturarla, pero no tanto que deje de valer la pena capturar al azar.
6. **Acción `setLure(speciesID)`** de extremo a extremo (store, worker, `surface.ts`, extensión), con modal nativo como cualquier compra. El núcleo revalida en el mismo bloqueo que cobra: vista, no desbloqueada, no legendaria y con saldo.
7. **Panel:** botón «Atraer · 24 h · 20M» en el detalle de una especie vista; en Inicio, el señuelo activo («Atrayendo a Charmander · quedan 5 h»), todo con textos del núcleo. UI y bench, @helper.
8. **Persistencia y sincronización:** `lure` se decodifica y se valida (entero positivo y `until` numérico); en una fusión viene del ganador, como `wild`; la transferencia lo acota.
9. **Simulador:** política en la que el perfil medio pone un señuelo a la especie vista más barata y no desbloqueada cuando le sobra saldo. Mide el tiempo medio hasta capturar la especie objetivo, con y sin señuelo.

## Preguntas abiertas

- ¿Se permite señuelo sobre legendarios? Propuesta: no; tienen su camino (hitos, racha, rastro).
- ¿Interacción con `owedLegendaryEncounters`? Ninguna.
- ¿Qué pasa si la cola está llena? El señuelo no genera apariciones extra; solo cambia el sorteo de las que toquen.

## Verificación

- `pokeapi`/`companion-store`: con señuelo, la especie objetivo aparece con la frecuencia esperada en N sorteos con `rng` fijo (inyectar que no se aplique el peso).
- Caducidad: tras `until`, el sorteo vuelve a la normalidad.
- Simulador: tiempo medio hasta ver la especie objetivo con y sin señuelo.
