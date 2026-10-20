# Fase 6 — Señuelo (apuntar a una especie)

**Plan maestro:** `00-master.md` § Fase 6. Hereda C6 (sumideros) y la fase 3b (sorteo por etapa).
**Estado:** borrador. Se detalla en modo plan justo antes de implementar.
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

## Preguntas abiertas

- ¿Se permite señuelo sobre legendarios? Propuesta: no; tienen su camino (hitos, racha, rastro).
- ¿Interacción con `owedLegendaryEncounters`? Ninguna.
- ¿Qué pasa si la cola está llena? El señuelo no genera apariciones extra; solo cambia el sorteo de las que toquen.

## Verificación

- `pokeapi`/`companion-store`: con señuelo, la especie objetivo aparece con la frecuencia esperada en N sorteos con `rng` fijo (inyectar que no se aplique el peso).
- Caducidad: tras `until`, el sorteo vuelve a la normalidad.
- Simulador: tiempo medio hasta ver la especie objetivo con y sin señuelo.
