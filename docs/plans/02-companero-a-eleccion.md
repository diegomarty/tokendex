# Fase 2 — Compañero a elección, inicial y evolución por barra

**Plan maestro:** `00-master.md` § Fase 2 y "Modelo objetivo". Hereda las decisiones "elegir inicial", "registra y evoluciona" y "ramas pendientes, luego shiny".
**Estado:** borrador. Se detalla en modo plan justo antes de implementar.
**Depende de:** fase 1 (mapa `species`), fase 1b (cifras).

## Objetivo

El jugador elige su compañero entre lo desbloqueado o un huevo; completar la barra registra la especie y evoluciona. La Pokédex muestra los cinco estados. Primer arranque con elección de inicial.

## Alcance

- `model.ts`: `active` pasa a `{ speciesID, isShiny, nature?, dittoDisguise? }`; el huevo a `egg?: { usage, tier?, pendingHatchID? }`, independiente de `active` (`sanitized` deja de borrar la garantía cuando hay compañero). La xp vive solo en `species`; `usedAtStage` desaparece (`COMPANION_STATE_SCHEMA` es 2 hoy y no cambió en la fase 1; esta fase decide si sube a 3 al cambiar la forma de `active`).
- `growth.ts`: ya acredita `species` desde la fase 1; aquí se añade la elección (`setCompanion`) y, en una especie registrada, el orden ramas pendientes → `shinyXP` (fase 5). Ditto: al revelarse, la xp pasa a `species[132]` (fase 1). El sobrante del huevo (`egg.usage − 5M`) entra en la especie eclosionada.
- `companion/starters.ts`: tabla de iniciales gen 1–5 (ids 1, 4, 7, 152, 155, 158, 252, 255, 258, 387, 390, 393, 495, 498, 501) con sus tipos.
- Acción **`setCompanion`** de extremo a extremo (patrón ya trazado): `protocol.ts` → `main.ts` → `surface.ts` → `extension.ts` (guarda propia: entero 1–649 o `'egg'`; `isOpaqueID` es para strings opacos; `CHANGING_REQUESTS`) → `scanWorker.ts` → función pura `setCompanion(state, target)` en el core, que rechaza especies no desbloqueadas.
- Acción **`chooseStarter`** (solo con el mapa `species` vacío y sin `active` ni huevo: tras la fase 1 el mapa siempre existe).
- Huevo (decisión de Diego): **uno gratuito al día, acumulables hasta 3** (`eggStock: { count, lastGrantDay }`, concedido junto a `noteAccrualDay` con `observation.todayDate`, dentro de `delta > 0`: solo un día con uso real; sembrado sin regalar días pasados). Incubar es una opción de compañero, de uno en uno; eclosionar desbloquea una especie aleatoria al 0 % con preferencia por lo no desbloqueado. Fusión fail-closed: `count` del ganador y `lastGrantDay` el más reciente. `persistence.ts`: `count` entero 0..3, `lastGrantDay` con forma de día, clave ausente → `{ count: 0 }`; `saveTransfer.ts`: acotar.
- **Huevos de tienda:** `buyEgg(tier)` deja de descartar al compañero y de exigir `active` (hoy `canBuyEgg` exige `active` y `buyEgg` lo descarta); requiere un huevo en incubación y le escribe `tier`; `eggGuarantee` lee `egg.tier`. Test: comprar sin huevo en incubación se rechaza (inyectar el descarte y ver que falla).
- `panel/build.ts`: `PanelDexSpecies` gana dos ejes, `status` (unknown | seen | unlocked | registered) y `shiny` (none | unlocked | registered), más `percent` y `canChoose`; `PanelCompanion` gana `registrationPercent`.
- `snapshot.ts`: barra de estado y tooltip con el % de registro.
- Webview: pantalla de inicial; en la Pokédex, estados y botón «Elegir como compañero»; placa del jugador con el %.
- `dev/scenarios.ts`: "dar xp a la especie", "registrar al instante", "forzar visto".

## Fuera de alcance

Capturas (fase 3), shiny (fase 5), señuelo (fase 6).

## Preguntas abiertas

- ¿Cambiar de compañero tiene coste o enfriamiento? Propuesta: gratis y sin límite; la experiencia solo va a uno, así que cambiar mucho ya tiene coste de oportunidad.
- Resuelto: el huevo vive en `egg?` independiente de `active`, así que se pausa conservando uso y garantía y se puede retomar.
- Las partidas existentes no ven la pantalla de inicial (ya tienen compañero): confirmar con la migración de la fase 1.

## Verificación

- `companion-growth`: barra llena → registrada + evoluciona; ramas pendientes antes que shiny (inyectar el orden inverso).
- `companion-store`: `setCompanion` rechaza ids no desbloqueados (fail closed) y `chooseStarter` solo en partida nueva; el huevo diario se concede una vez por día y nunca pasa de 3 (inyectar `<=` y ver que falla); sin huevo en stock no se puede incubar.
- `companion-merge`: `eggStock` por máximo acotado, sin duplicar el huevo del día entre dos máquinas.
- `panel-build`, `dex-view`: estados y porcentajes.
- Host: `extension.ts` valida ids (test de `surface`/`extension` si existe; si no, bench).
- Bench: Pokédex y elección de compañero en claro/oscuro, 280–600 px; e2e.
