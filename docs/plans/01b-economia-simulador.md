# Fase 1b — Tabla de economía y simulador

**Plan maestro:** `00-master.md` § Fase 1b. Hereda C3 (escala), C5 (shiny), C6 (economía por herramienta) y la decisión "tokens brutos".
**Estado:** borrador. Se detalla en modo plan justo antes de implementar.
**Depende de:** fase 1 (la escala nueva y el mapa `species`).

## Objetivo

Una sola tabla con todas las fuentes y sumideros de tokens, y una herramienta que responda con números antes de fijar cualquier precio o recompensa de las fases 2–6.

## Alcance

- `src/core/companion/economy.ts`: `EconomyBalance` con todas las constantes de fuentes y sumideros que hoy están repartidas (`Pokeball`, `RareCandy`, `Mint`, `ShinyCharm`, `FreshEgg`, `TrailBalance`, `StealBalance`, `FIND_TABLE`, `MilestoneBalance`, `StreakBalance`) o referencias a ellas, más las nuevas: recompensa por duplicado, impulso shiny, señuelo. Nunca un literal suelto en otro módulo.
- `tools/economy-sim/`: script Node (`make sim`) que simula N días con perfiles **ligero 20M/día, medio 100M/día, intenso 500M/día** y una política de jugador (lanza a 1 de cada 8 encuentros, compra balls cuando se acaban, usa caramelos, elige compañero no registrado…). Salida: días hasta registrar una línea por rareza, hasta la Pokédex completa, hasta la primera shiny; saldo acumulado por día; % de ingresos gastados.
- `docs/game-design.md`: el modelo del maestro y las constantes vigentes, como referencia de todos los sub-planes.

## Preguntas que debe responder

1. ¿Se infla el saldo con el plan? (Diego gasta hoy el 17 %.) Objetivo: que un usuario intenso gaste entre el 40 % y el 70 % de lo que gana sin sentirse obligado.
2. Recompensa por duplicado por rareza (propuesta 2M / 10M / 30M / 80M), siempre por debajo de la mitad del coste esperado de captura (C6), ingresada en `earnedTokens`.
3. Tope y cambio del impulso shiny (propuesta: 1:1 hasta el 50 %). El simulador se **parametriza** con las mecánicas de las fases 5 y 6 aunque aún no existan en el código, para que esas fases fijen sus constantes sin depender de la 4.
4. Precio y duración del señuelo (fase 6).
5. Si los precios actuales de balls, huevos, caramelo y amuleto siguen teniendo sentido con la escala ÷15 (fase 4).

## Preguntas abiertas

- ¿Perfiles sacados del corpus real (`tools/scan-real`) o sintéticos? Propuesta: sintéticos con los tres ritmos, y un cuarto perfil "chat" de 2M/día para ver el modo lento.
- Reutilizar el motor real (`encounters.ts`, `growth.ts`, `shop.ts`) en el simulador en lugar de reimplementarlo: es puro y sin `vscode`, así que se puede.

## Verificación

- El simulador es una herramienta, no código de producción. `EconomyBalance` **es** la fuente de cada precio y recompensa (las tablas actuales se mueven o re-exportan desde ella, sin duplicar valores); un test comprueba que ningún otro módulo define un precio.
