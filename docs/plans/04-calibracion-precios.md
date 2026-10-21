# Fase 4 — Calibración de precios

**Plan maestro:** `00-master.md` § Fase 4. Hereda C3, C5 y C6.
**Estado:** detallado (2026-10-21), en implementación.
**Depende de:** fases 1b, 3 y 3b. Calibra lo que **ya existe** más los duplicados; el impulso shiny y el señuelo los calibran sus propias fases (5 y 6) con el simulador parametrizado, para no crear un ciclo.

## Objetivo

Que cada precio y recompensa esté justificado por el simulador y fijado en tests, como hoy la tabla de captura en `wild-encounters`.

## Qué se revisa

| Elemento | Hoy | Pregunta |
|---|---|---|
| Balls | 5M / 15M / 40M, Master 1,5B | ¿Siguen bien con 50–80 apariciones/día para un usuario intenso? |
| Bayas | 3M / 3M / 8M | ¿Se usan? El simulador mide cuánto aportan a la captura. |
| Caramelo Raro | 500M (tienda), 25 % de etapa, tope 2 | Con etapas de 8–200M, ¿500M sigue teniendo sentido, o pasa a precio relativo? |
| Menta | 100M | Cosmético; probablemente bajar. |
| Amuleto Iris | 3B | ¿Efecto en el impulso shiny (C5)? |
| Huevos de tienda | 1B / 2,5B / 4B | Ya no dan un huevo: son el precio de la **garantía de tier** sobre un huevo en incubación (los huevos llegan uno al día, gratis). ¿Vale 1B garantizar "poco común o mejor" frente a capturar (~6M)? Probablemente bajar mucho. |
| Rastro | 100M × 2^n | OK a priori. |
| Robos | 0,5–4M por ataque, 3 por encuentro | OK a priori. |
| Finds | ~10M de valor esperado | OK a priori. |
| Duplicados | 2M / 10M / 30M / 80M (propuesta) | Validar < mitad del coste de captura (3M era exactamente la mitad). |
| Impulso shiny | 1:1 hasta el 50 % | Lo calibra la fase 5 con el simulador; aquí solo se comprueba que el saldo típico lo permite. |
| Señuelo | a definir | Lo calibra la fase 6. |

## Objetivos numéricos (a confirmar con Diego)

- Usuario intenso: gasta el 40–70 % de lo que gana.
- Usuario medio: Pokédex en 1–2 años; primera shiny en < 1 mes si se lo propone.
- Usuario de chat (2M/día): un encuentro al día y una evolución a la semana.

## Decisiones de Diego (2026-10-21)

- **Sumideros para el intenso:** se esperan a la fase 5 (el impulso shiny). La fase 4 solo recalibra los precios que ya existen.
- **Escala:** se mantiene ÷15. Usar poco la IA no debe empujar a terminar antes. El objetivo de 6–12 meses para la Pokédex se mide con el uso real de Diego, no con el perfil medio; después viene la Shinydex, más larga.
- **Ampliar la Pokédex más allá de la #649** (hay más de 1000 especies): idea para una fase propia (ver `07-ideas.md`). Los sprites animados solo llegan a la #649 (gen V), así que las especies nuevas usarían sprites estáticos. Cada especie añadida encarece completar la Pokédex.
- **Garantías de huevo:** bajarlas mucho.

## Diseño detallado

| Elemento | Antes | Ahora | Por qué |
|---|---|---|---|
| Garantía «poco común o mejor» | 2,5B | **50M** | Base de 20M con la proporción de la tabla de graduación (1 : 2,5 : 4), que impide que la de rara salga peor que comprar dos poco comunes. |
| Garantía «rara o mejor» | 4B | **80M** | Por debajo de la captura rara más barata (102M), pero limitada a un huevo al día que hay que incubar. |
| Huevo «sin garantía» | 1B | **retirado** | Ya no da un huevo; solo volvía a sortear la especie. |
| Caramelo Raro | 500M | **150M** | Sigue por encima de lo máximo que vale (25 % de la etapa más cara = 100M, legendario de una forma). Nunca es experiencia barata, pero es un sumidero útil. |
| Menta | 100M | **30M** | Un quinto del caramelo, como dice su regla. |
| Balls, bayas, rastro, robos, hallazgos, duplicados | — | sin cambios | El simulador no muestra problema: el perfil ligero gasta casi todo en balls y el medio la mitad. |

Los tests fijan las relaciones (`test/economy.test.ts`):
- caramelo > su máximo valor en experiencia;
- menta = caramelo ÷ 5;
- garantía rara < la captura rara más barata;
- la garantía rara no sale peor que la poco común;
- la tienda no vende garantías sin tier.

## Notas de la implementación

- Fallo de la fase 2 encontrado al calibrar: la tienda del panel enseñaba las garantías con un compañero en juego (deshabilitadas) y no con un huevo incubando, y la nota del grupo seguía diciendo que el huevo «suelta a tu Pokémon». Ahora se listan solo con `eggOnStage`, igual que `canBuyEgg`, y la nota explica que garantizan la rareza del huevo que incubas.
- Simulador, 180 días: casi sin cambios (medio, 56 % gastado; intenso, 17–18 %), porque la política del simulador no compra garantías y casi no compra caramelos. El sumidero del intenso queda para la fase 5, como decidió Diego.

## Verificación

- Un test por tabla de precios que fije los valores y las relaciones (p. ej. `duplicateReward < expectedCatchCost / 2`, `Mint.price < RareCandy.price`), como ya existe para el caramelo y la menta.
