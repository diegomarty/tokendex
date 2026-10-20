# Fase 7 — Ideas de diseño a priorizar

**Plan maestro:** `00-master.md` § Fase 7.
**Estado:** lista de candidatas. Cada una que se apruebe tendrá su propio sub-plan.
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
