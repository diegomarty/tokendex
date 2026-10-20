# Fase 4 — Calibración de precios

**Plan maestro:** `00-master.md` § Fase 4. Hereda C3, C5 y C6.
**Estado:** borrador. Se detalla en modo plan justo antes de implementar.
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

## Verificación

- Un test por tabla de precios que fije los valores y las relaciones (p. ej. `duplicateReward < expectedCatchCost / 2`, `Mint.price < RareCandy.price`), como ya existe para el caramelo y la menta.
