# Fase 1b — Tabla de economía y simulador

**Plan maestro:** `00-master.md` § Fase 1b. Hereda C3 (escala), C5 (shiny), C6 (economía por herramienta) y la decisión "tokens brutos".
**Estado:** implementado en `feat/species-registry` (2026-10-20): `tools/economy-sim.ts` (`make sim`), `src/core/companion/economy.ts` y `docs/game-design.md`.

## Primera medición (`make sim --days 180 --seed 1`, motor real, sin bayas, 1 intento de cada 8 encuentros)

| Perfil | Tokens/día | 1.ª especie registrada | Registradas | Desbloqueadas | Capturas / encuentros | Saldo final | % ingresos gastado | Pokédex completa (analítico) |
|---|---|---|---|---|---|---|---|---|
| chat | 2M | día 38 | 4 | 48 | 49 / 130 | 35M | 87 % | 89 años |
| ligero | 20M | día 3 | 37 | 136 | 123 / 1.299 | 65M | **97 %** | 8,9 años |
| medio | 100M | día 2 | 130 | 218 | 175 / 6.180 | 5B | 61 % | 1,8 años |
| intenso | 500M | día 1 | 236 | 274 | 166 / 9.011 | **57B** | **12 %** | 130 días |

Lo que dice:

- **El usuario intenso infla el saldo**: 57B en seis meses gastando el 12 %. Los sumideros grandes del plan (impulso shiny, señuelo) no son opcionales; hasta que existan, a ese perfil le sobra todo.
- **El usuario ligero gasta el 97 %**: con 20M/día, las balls (5M / 15M / 40M) se comen el ingreso y el monedero no crece nunca. La fase 4 tiene que mirar los precios de las balls desde abajo, no solo desde arriba.
- **El medio va algo más lento que el cálculo analítico** (130 registradas en 180 días → ~2,5 años para 649, frente a 1,8 analíticos): el bucle huevo → línea → huevo gasta tokens en eclosiones y en etapas que ya estaban registradas. La elección de compañero (fase 2) debería acercarlo al cálculo.
- **Los encuentros sobran**: 48 al día para el medio, casi todos caducan; la captura está limitada por la atención del jugador, no por los tokens. Las recompensas por duplicado no pueden ser una granja, pero tampoco hace falta que sean generosas.
- El perfil chat vive del primer tramo barato (una especie registrada al día 38, 48 desbloqueadas por captura): el "modo lento" existe y funciona.

Política del jugador simulada: recoge los finds, lanza a 1 de cada 8 encuentros con la ball adecuada por rareza (Poké para común y poco común, Ultra para rara y legendaria, hasta 5 lanzamientos, compra packs de 10 cuando se queda sin), usa los caramelos en cuanto los tiene. Sin bayas, sin rastro, sin cambiar de compañero (fase 2). Semana laboral de 5 días, 12 refrescos por día.
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
