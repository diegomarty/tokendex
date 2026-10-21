# Fase 7 — Ideas de diseño a priorizar

**Plan maestro:** `00-master.md` § Fase 7.
**Estado:** Diego aprobó (2026-10-21), en este orden: **medallas e hitos**, **retos diarios/semanales** y **regiones por generación**. Ampliar la Pokédex queda aparcado. El resto sigue como candidato.
**Depende de:** las fases 1–6, según la idea.

| Idea | Qué aporta | Qué toca | Depende de |
|---|---|---|---|
| **Medallas e hitos** («10 registradas», «primera shiny», «una línea completa», «una generación») | Objetivos intermedios visibles en el camino de 1–2 años | `species` (lectura), un `badges` en el estado, una pestaña o sección | 1, 2 |
| **Retos diarios/semanales** («captura un tipo fuego», «registra un 5 %») | Un motivo para abrir el panel cada día; recompensa en tokens | tipos ya guardados en los encuentros; generador determinista por día; `EconomyBalance` | 3, 4 |
| **Amistad del compañero** (días seguidos como compañero → bonus de xp pequeño) | Premia la constancia; reutiliza la racha | `accrualDays`, `active`, `growth.ts` | 2 |
| **Regiones** (completar gen 1–5 con insignia) | Divide la Pokédex en metas de ~150 especies | filtro por rango de id (ya existe la búsqueda), insignias | 2 |
| **Tabla de tipos en los encuentros** (tipo del compañero vs salvaje → captura o ánimo) | Motivo para elegir compañero según lo que quieres cazar | `types` ya guardados; `catchChance`/`initialMood` | 2, 3 |
| **Guardería** (un segundo Pokémon gana un % pequeño de xp pasiva) | Progreso en paralelo sin romper "la xp va a uno" | `species`, `creditDelta` | 2 |

Criterio para priorizar: primero lo que da objetivos intermedios (medallas, regiones), porque la escala de 1–2 años necesita metas a 1–2 semanas.

## Ampliar la Pokédex más allá de la #649 (Diego, 2026-10-21)

Hay más de 1000 especies; hoy el juego se limita a las 649 con sprite animado (gen V, `ANIMATED_SPECIES_MAX`). Para ampliarla:
- sprites estáticos (o los de Showdown) para las especies nuevas;
- índice, salvajes y huevos que respeten el nuevo tope;
- recalibrar la escala: cada especie añadida encarece completar la Pokédex (hoy 46,5B a ÷15).

Va en una fase propia, después de la Shinydex. **Aparcada** por Diego (2026-10-21).

## 7a — Medallas e hitos (diseño detallado)

- **Catálogo fijo** (`medals.ts`, puro). Cada medalla es una condición sobre el estado, sin datos propios, y se deriva siempre del registro:
  - especies registradas: 1, 10, 50, 100, 250, 649;
  - shinies registradas: 1, 10, 50;
  - capturas totales: 10, 100, 1000;
  - primera línea completa: una graduación, es decir, una entrada `dex` sin `source`;
  - una por región completa (7c).
- **Estado:** `CompanionState.medals?: string[]`, los ids ya celebrados. Solo crece. Sirve para avisar una sola vez: en cada pliegue, las medallas que se cumplen y no están celebradas se añaden y lanzan el evento `medalEarned` con su aviso.
  - **Migración:** una partida vieja que ya cumple medallas las recibe de golpe en silencio, sin avisos. Se marca con `medalsSeeded`.
- **Fusión:** unión de las dos listas. **Transferencia:** se filtran los ids que no existen.
- **Panel:** `PanelState.medals`, un array de { id, name, description, earned, progressText } con todo formateado («37 / 50»), más un recuento. UI de @helper: una sección de Medallas en la Pokédex.
- **Textos:** nombre y descripción de cada medalla en ko/en/ja/es.

## 7b — Retos diarios y semanales (diseño detallado)

- **Generador determinista** por día (`yyyy-MM-dd`) y por semana ISO, con una semilla derivada de la fecha: todas las máquinas ven el mismo reto el mismo día. 2 retos diarios y 1 semanal. Tipos:
  - capturar N Pokémon (diario 3, semanal 15);
  - capturar uno de tipo X (X entre los 17 tipos, sorteado);
  - registrar una especie nueva al 5 % (primera captura);
  - ganar N tokens como compañero (diario 2M, semanal 20M; con un tope pensado para que el perfil de chat pueda cumplirlo).
- **Estado:** `CompanionState.challenges?: { day, week, items: { id, kind, target, progress, done }[] }`. Al cambiar de día o de semana se regeneran los de ese periodo. El progreso se suma en el pliegue (tokens) y en `takeTurn` (capturas, tipo, nueva especie).
- **Recompensa:** al completarse, se suma a `earnedTokens` en el acto, con aviso. Diario 5M, semanal 40M (`EconomyBalance.challenge`). Regla del test: un día de retos no paga más que el coste esperado de las capturas que pide.
- **Fusión:** el ganador; si los dos son del mismo día, el progreso máximo por reto. Nunca se paga dos veces: la recompensa va con `done`, que solo pasa a verdadero una vez.
- **Panel:** `PanelState.challenges`, con { text, progressText, done, rewardText } por reto, en Inicio. UI de @helper.

## 7c — Regiones por generación (diseño detallado)

- **Rangos de id:** Kanto 1–151, Johto 152–251, Hoenn 252–386, Sinnoh 387–493, Teselia 494–649 (`regions.ts`).
- **Progreso:** registradas por región / total de la región, derivado del registro. Una medalla por región completa (7a).
- **Panel:** `dexSummary.regions`, con { id, name, registered, total, percent, progressText }. La Pokédex filtra por región. UI de @helper.

## Notas de la implementación (7a, 7b, 7c)

- 7a: `medals.ts` (23 medallas, derivadas del registro, `awardMedals` con siembra silenciosa) y `regions.ts`. Se conceden al final de `grow()` (pliegue y caramelo), del turno y del impulso.
- 7b: `challenges.ts` (2 diarios y 1 semanal, deterministas por fecha, con semana ISO). Recompensas en `EconomyBalance.challenge`.
- 7c: el núcleo va dentro de 7a (`regionProgress`, `dexSummary.regions` y una medalla por región). El filtro de la Pokédex es de @helper.
- Revisión de código, corregido con test e inyección:
  - **Doble cobro de retos entre máquinas** con fechas distintas (zonas horarias o reloj desfasado): registro `challengesPaid`. Un reto regenerado cuyo id ya se pagó vuelve hecho y no se cobra otra vez. La fusión une los dos registros.
  - **Tablero falsificado en una importación:** el tablero se reconstruye siempre desde el generador (`boardFor`), y del guardado solo se toman el progreso y el `done` de los retos que esa fecha reparte. Un tablero nunca paga más de tres recompensas.
  - Una captura tras la medianoche, antes del primer pliegue del día, cuenta para el tablero de hoy.
  - El panel no enseña el tablero de otro día como «Hoy».
  - Las medallas con ids desconocidos (de una versión más nueva) se conservan, para que esa versión no las anuncie dos veces.
  - Las medallas también se conceden desde `grow()`, así que cubren el Caramelo Raro.
  - La recompensa de los retos se define en un solo sitio (`challengeReward`). Los JSDoc de `EconomyBalance` y `PanelDexSummary` vuelven a su sitio.
- Sin cambios, a conciencia: el reto «usa N tokens» cuenta el uso de **esta** máquina. Con dos máquinas, la fusión toma el mayor progreso de las dos, no la suma. Sumar exigiría llevar la cuenta por dispositivo, y el reto se puede cumplir de todos modos en una.
