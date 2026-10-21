# Plan maestro: experiencia por especie, compañero a elección y nueva economía

> Fichero vivo. Cada fase tiene su sub-plan en `docs/plans/NN-*.md`, que referencia este maestro y hereda sus decisiones (tabla de abajo y conclusiones C1–C6). Un sub-plan se detalla en modo plan justo antes de implementar su fase; hasta entonces es un borrador con el alcance, las dependencias y las preguntas abiertas.

| Fase | Sub-plan | Depende de |
|---|---|---|
| 0 | commits del trabajo actual (en este fichero) | — |
| 1 | `01-registro-por-especie.md` | 0 |
| 1b | `01b-economia-simulador.md` | 1 |
| 2 | `02-companero-a-eleccion.md` | 1, 1b |
| 3 | `03-capturar-registra.md` | 1, 1b |
| 3b | `03b-salvajes-evolucionados.md` | 3, 1b |
| 4 | `04-calibracion-precios.md` | 1b, 3, 3b (calibra lo existente y los duplicados) |
| 5 | `05-shiny.md` | 2, 1b (fija sus constantes con el simulador) |
| 6 | `06-senuelo.md` | 3b, 1b |
| 7 | `07-ideas.md` | a priorizar |

## Contexto

Hoy el juego gira en torno a **un solo Pokémon que se cría hasta graduarse**:

- Los tokens observados se usan dos veces. Hacen crecer al compañero (`creditDelta` en `ledger.ts`, que alimenta `active.usedAtStage`) y llenan el monedero (`spendableBalance = usedSinceInstall − spentTokens`).
- Al graduarse, la cadena entra en la Pokédex como un registro por individuo (`DexEntry`) y vuelve a salir un huevo aleatorio. Graduarse no da ninguna recompensa.
- Capturar un salvaje solo añade un registro `source: 'wild'`. No hay recompensa ni progreso.
- Nada guarda progreso **por especie**, y no existe el estado «visto».

Diego quiere que el progreso tenga sentido por especie. **Los tokens que gasta el compañero son su experiencia.** Cada especie tiene una barra que hay que completar para **registrarla**; si no, solo tienes un porcentaje.

Además:

- **Inicio:** se empieza con un solo inicial.
- **Compañero a elección:** puede ser cualquier Pokémon desbloqueado o un huevo.
- **Captura:** capturar da el 5 % del registro y desbloquea la especie. Si ya la tenías, da tokens.
- **Señuelo:** se puede apuntar a una especie que no tienes para que aparezca más.
- **Shiny:** con una especie ya al máximo, acumular ×10 de experiencia desbloquea su forma shiny. Esto añade una Shinydex.
- **Economía:** se replantea para que todo encaje.

**Decisiones ya tomadas por Diego**

| Tema | Decisión |
|---|---|
| Tokens | **Doble uso.** Cada token da 1 de experiencia al compañero y 1 de saldo. Gastar nunca quita experiencia. |
| Partidas existentes | **Todo al 0 %.** Cada especie que ya tienes (graduada o capturada) queda *desbloqueada* al 0 %; el compañero sigue siendo el mismo, al 0 %. Sin umbrales ni acotados en la migración. El monedero y el historial de capturas no se tocan. |
| Inicio | **Elegir inicial** entre los iniciales de las gen 1–5. |
| Barra completa | **Registra y evoluciona.** La especie queda registrada, el compañero evoluciona a la siguiente forma (que se desbloquea y empieza su barra) y siempre puedes volver a elegir la forma anterior. |
| XP de una especie ya registrada | **Ramas pendientes, luego shiny.** Si tiene hijos sin desbloquear, cada `registerXP` extra abre la siguiente rama; si no, alimenta `shinyXP`. Así cualquier forma puede ser shiny y las ramas (Eevee) se pueden completar. |
| Formas evolucionadas salvajes | **Sí, con peso reducido**, como en los juegos: 65/30/5 para líneas de 3 etapas y 75/25 para las de 2, y con incentivo a las especies que aún no tienes. Hoy el índice solo sortea inicios de línea; esto es un sub-plan propio (fase 3b). |
| Economía | **El simulador va antes** (fase 1b); las fases 2–3 fijan sus constantes con datos. |
| Escala | **`graduationTotal` ÷ 15** (C3): Pokédex completa en 1–2 años para un usuario medio. Va en la fase 1. |
| Caramelo Raro | **25 % del umbral de la etapa actual, máximo 2 por especie** (C4). Fase 1. |
| Shiny | **Una sola barra** `8 × registerXP` con impulso opcional pagado hasta la mitad (C5). Fase 5. |
| Moneda | **Tokens brutos** (C6), el mismo número que muestra el panel. Sin ponderar por coste. |
| Registrar al 100 % | **No da tokens.** Su recompensa es la evolución, la Pokédex y la vía shiny. |
| Huevos | **Un huevo gratuito al día, acumulables hasta 3.** Incubar uno es siempre una opción de compañero (de uno en uno, 5M para eclosionar). Los huevos de tienda solo añaden la garantía de tier. |

**Forma de trabajo.** Este es el plan **maestro**. Cada fase empieza con **su propio sub-plan**, en modo plan, analizado a fondo antes de tocar código. Cada fase:

- se puede entregar y probar por separado;
- sigue `CLAUDE.md`: test primero con inyección de defecto, el core puro y ya localizado, y ninguna lista privada.

Lidero yo («main»). @helper recibe tareas acotadas y me informa antes y después de cada una.

---

## Conclusiones del análisis (en curso)

### C1. Con la escala actual, completar la Pokédex por experiencia es inalcanzable

Datos del índice real cacheado (`base-index.json`, 328 líneas evolutivas de gen 1–5) y de la partida de Diego (20 oct 2026):

| Rareza | Líneas | `graduationTotal` | Coste total |
|---|---|---|---|
| Común | 175 | 0,75B | 131B |
| Poco común | 33 | 1,875B | 62B |
| Rara | 72 | 3B | 216B |
| Legendaria | 48 | 6B | 288B |
| **Total** | **328** | | **697B** |

Como los umbrales de cada etapa suman el `graduationTotal` de la línea, **registrar las 649 especies al 100 % cuesta 697B de tokens**, sea cual sea el reparto por etapas. Las 48 líneas legendarias son el 41 %.

Ritmos de uso de referencia (la partida de Diego acumula 4,43B en 6 días de actividad, ~0,7B/día):

| Perfil | Tokens/día | Pokédex completa |
|---|---|---|
| Intenso (Diego) | 0,5–0,7B | 3–4 años |
| Medio | 0,1B | ~19 años |
| Ligero | 0,02B | ~95 años |

El 5 % por captura y la recompensa por duplicado no cambian el orden de magnitud. La escala actual se diseñó para **un** compañero cada vez (una línea común tarda 1,5 días para Diego, 7,5 para un usuario medio); multiplicarla por 328 líneas rompe el objetivo de "completar".

**Decisión de Diego:** la Pokédex completa debe costar a un usuario medio **1–2 años**, y registro y evolución comparten **un solo umbral**, más barato que hoy.

### C2. Estado real de la partida de Diego (para la migración)

45 registros: 40 capturas salvajes y 5 líneas graduadas; por `rarity` de los registros, 40 comunes, 3 poco comunes y 2 legendarias. Compañero: Magikarp→Gyarados en etapa 2 con 378M. Con la migración acordada (todo al 0 %): las 45 especies quedan desbloqueadas al 0 % y Gyarados sigue siendo el compañero, al 0 % (378M en la escala vieja ≈ 1 h de juego en la nueva).

### C3. Escala nueva: `graduationTotal` ÷ 15

| Rareza | Hoy | Nuevo | Etapas (línea de 3) | Línea: usuario medio / Diego |
|---|---|---|---|---|
| Común | 750M | **50M** | 8M · 17M · 25M | 0,5 d / 2 h |
| Poco común | 1,875B | **125M** | 21M · 42M · 62M | 1,2 d / 5 h |
| Rara | 3B | **200M** | 33M · 67M · 100M | 2 d / 8 h |
| Legendaria | 6B | **400M** | 67M · 133M · 200M | 4 d / 16 h |

- Total Pokédex: **46,5B** → usuario medio 1,3 años, Diego 77 días, ligero 6 años.
- Conserva **exactamente** las proporciones actuales (1 : 2,5 : 4 : 8), así que todo lo que deriva de ratios (precio de los huevos por tier, `phaseThreshold`, `meetsRarityFloor`) no cambia.
- **Shiny ×10** sobre esa escala: común 500M (medio 5 d, Diego 20 h), legendaria 4B (medio 40 d, Diego 7 d). La Shinydex completa cuesta 465B: inalcanzable a propósito, es el prestigio a largo plazo. El compañero puede quedarse días en su forma final alimentando la shiny, lo que compensa que las líneas se completen rápido.
- **Hay que reescalar lo denominado en experiencia:** `RareCandy.xp` (100M fijos; con la escala nueva serían 2 líneas comunes enteras → pasa a ser relativo al umbral de la etapa actual, p. ej. el 25 %) y los tests que fijan cifras (`companion-growth`, `companion-model`, `companion-store`, `dev-simulation`, el comentario de `wild-encounters`).
- **No cambia:** `eggHatchThreshold` 5M, `MilestoneBalance` 1B (es uso, no experiencia), precios de la tienda (son monedero; se calibran en la fase 4 con el simulador).

### C4. Caramelo Raro: relativo al umbral y con tope (decisión de Diego)

- Un caramelo vale el **25 % del umbral de la etapa actual** (`rareCandyXP(mon) = round(0.25 × phaseThreshold(...))`), en lugar de 100M fijos. Así vale lo mismo en cualquier escala y nunca registra una especie de golpe.
- **Máximo 2 caramelos por especie** (`candiesUsed` en `SpeciesProgress`; `RareCandy.maxPerSpecies = 2`), nunca sobre la barra shiny. Con dos caramelos se cubre como mucho la mitad de una etapa, lo que evita que la entrega semanal de 5 convierta el registro en una compra.
- Afecta a: `RareCandy` en `model.ts`, `canUseRareCandy`/`consumeRareCandy` en `shop.ts`, `applyCandy` en `store.ts`, decodificación y `sanitized` (acotar `candiesUsed`), la descripción del objeto en `dispatch.ts` (hoy dice "100M"), una pista en la bolsa cuando el Pokémon ya está lleno, y los tests que fijan "100M" (`i18n`, `panel-build`). Va en la **fase 1** (mismo cambio de escala).

### C5. Shiny: una sola barra, con impulso opcional (decisión de Diego)

Sin pago obligatorio. Eliges la especie registrada como compañero y su experiencia va a `shinyXP`; al llenarse, la shiny queda registrada y se puede vestir. Diego quiere que una legendaria shiny le cueste **unos 5 días**, no 20:

- `shinyXP = 8 × graduationTotal(lineRarity)` para **cada forma** de la línea (no 8 × el umbral de etapa, que daría 67M para Charmander): común 400M, poco común 1B, rara 1,6B, legendaria 3,2B. Cada especie es independiente.

| Rareza | `shinyXP` | Usuario medio | Diego |
|---|---|---|---|
| Común | 400M | 4 d | 16 h |
| Poco común | 1B | 10 d | 1,7 d |
| Rara | 1,6B | 16 d | 2,7 d |
| Legendaria | 3,2B | 32 d | 5,3 d |

- **Impulso shiny (sumidero):** se pueden gastar tokens del monedero para acelerar la barra, a razón de 1:1 y **como mucho hasta la mitad** del requisito (común ≤200M, legendaria ≤1,6B), para que siempre haya que jugarla en parte. El tope y el cambio los afina el simulador. Esto conserva el gran sumidero de la economía sin obligar a pagar.
- Capturar un salvaje shiny (1/64; 1/48 con el Amuleto) o que eclosione uno **completa la barra shiny de esa especie** al instante, así el sorteo sigue valiendo.
- Shinydex completa: del orden de 0,7T (8 × la suma de `graduationTotal` por **especie**, unas 649), inalcanzable a propósito (prestigio).

Esto sustituye el «×10» de la fase 5.

### C6. Economía de tokens para todas las herramientas

**Qué es un "token" hoy.** `totalTokens = input + output + cacheWrite + cacheRead` para todos los proveedores (`usage/entry.ts:34`; Copilot en VS Code resta `cached_tokens` de `input` solo para no contarlos dos veces). Datos reales de Diego, Claude Code, últimos 30 días (solo agregados):

| | |
|---|---|
| Media / mediana / máximo diario | 165M / 102M / 533M |
| Mezcla | **97,9 % lecturas de caché**, 1,8 % escrituras de caché, 0,2 % salida, ~0 % entrada |
| Modelos | Opus 5.5 (3,05B) y Opus 5 (1,41B) |
| Coste medio | ~$0,65 por millón (450M → $292 en el panel) |
| Codex | ~10M al mes: irrelevante |
| Gasto en el juego | 765M de 4,43B (17 %), todo en balls; 310 encuentros vistos, 40 capturas (lanza a 1 de cada 8) |
| Ritmo de encuentros observado | 1 por cada ~14M (teórico: 1 por 2M; lo frenan la cola llena de antes, 12, y la caducidad) |

**Conclusión 1: la moneda son casi solo lecturas de caché.** Un CLI agéntico reenvía todo el contexto en cada turno, así que el volumen depende del tamaño del contexto y de cuántos turnos hay, no de "cuánto trabajas". Es inherente a usar tokens; es real (se paga) y no se puede falsear sin pagarlo.

**Conclusión 2: la dispersión entre herramientas es de ~100×, y la de precio ~7×.**

| Perfil | Tokens/día (estimación) | Línea común (50M) | Pokédex (46,5B) |
|---|---|---|---|
| CLI agéntico intenso (Diego) | 150–600M | horas | ~3 meses |
| CLI agéntico medio | ~100M | medio día | ~1,3 años |
| CLI ligero | ~20M | 2,5 d | 6 años |
| Chat en el editor (Copilot Chat, Cursor) | 1–5M | 10–50 d | nunca |

Un token de lectura de caché cuesta $0,5/M en Opus, $0,1 en Haiku y $0,075 en Gemini Flash; uno de salida, $25/M en Opus. La misma "cantidad de juego" vale 7× más o menos según el modelo, y 50× según el tipo de token dentro del mismo modelo.

**Opciones para la unidad de la economía:**

- **A. Tokens brutos (hoy).** Es la identidad del producto ("los tokens que quemas son tu monedero", README), coincide con el número del panel y no añade una segunda cifra (regla de `CLAUDE.md`: una sola fuente de verdad). Coste: los usuarios de chat juegan en "modo lento".
- **B. Tokens ponderados por coste** (`costFor` ya existe; p. ej. coste ÷ precio de referencia). Reduce la dispersión entre herramientas a ~10× y entre modelos a 1×. Coste: una segunda cifra distinta de la del panel, difícil de explicar, y depende de una tabla de precios que envejece.
- **C. Escala adaptativa por usuario** (umbrales en "días de uso propio"). Descartada: la experiencia deja de ser transparente y se abarata jugando menos.

**Decisión: A** (tokens brutos), con dos salvaguardas: (1) el tramo inicial sigue siendo barato en términos absolutos para que un usuario de chat tenga un latido diario (primer encuentro 500k, eclosión 5M, una aparición cada 2M, primera etapa común 8M); (2) el objetivo "Pokédex en 1–2 años" se define para el usuario agéntico medio, y se asume que la Pokédex completa no es para los usuarios de chat. Si los datos de uso muestran que esos usuarios son muchos, se reabre B.

**Fuentes y sumideros por día, usuario medio (100M/día), con las cifras del plan:**

| | Hoy | Con el plan |
|---|---|---|
| Fuentes | tokens 100M; finds ~10M de valor (25 % de ~50 apariciones teóricas, en la práctica muchas menos); caramelos por ventanas al 100 %; legendarios por hito (1B) y racha | + duplicados y eclosión (el primer registro **no** da tokens, por decisión) |
| Sumideros | balls 5/15/40M (Master 1,5B), bayas 3/3/8M, caramelo 500M, menta 100M, amuleto 3B, huevos 1/2,5/4B, rastro 100/200/400M, robos 0,5–4M | + impulso shiny (hasta la mitad de `shinyXP`: común ≤200M, legendaria ≤1,6B), señuelo |

Diego gasta el 17 % de lo que gana. Con el plan, el gasto natural sube: el impulso shiny y el señuelo son los primeros sumideros grandes que un usuario intenso usará a diario.

**Reglas anti-abuso para las cifras de la fase 3** (duplicados). La recompensa por duplicado queda **estrictamente por debajo de la mitad del coste esperado de la captura más barata de su banda** (el `captureRate` techo de la banda, con la ball adecuada y el ánimo inicial de un carácter neutro), porque esa es la que se podría granjear. Calculado con el motor real (`catchChance`): común (Poké Ball, cr 255) P 0,89 → 5,6M; poco común (Poké Ball, cr 120) P 0,50 → 9,9M; rara (Ultra, cr 45) P 0,41 → 98M; legendaria (Ultra, cr hasta 45: Mew, Celebi, Jirachi) → 98M. Recompensas: **2M / 4M / 30M / 40M**. Las cifras que había antes aquí (6M/70M/175M y 10M/80M) salían de una estimación a mano y no cuadraban; el test de `economy.ts` deriva el límite del motor, así que no puede volver a pasar. **Cómo se ingresa:** el monedero es `usedSinceInstall − spentTokens` y `sanitized` acota `spentTokens` a ≥ 0 (por eso el reembolso de robos se limita a `min(stolen, spentTokens)`); restar la recompensa de `spentTokens` se perdería en silencio para quien gasta poco. Se añade `earnedTokens` (solo crece) y `spendableBalance = used + earned − spent`, con su regla en `sanitized` (acotar) y en `mergeSaves` (del ganador, como `spentTokens`).

**Coste de desbloquear toda la Pokédex capturando** (fase 3 + 3b): ~649 especies × coste esperado de captura ≈ **4–8B** según la mezcla de rarezas. Desbloquear es barato; registrar (46,5B) es el juego largo. Coherente con lo pedido.

---

## Fase 0 — Commit de lo que hay (lo primero, nada más aprobar)

Todo lo hecho en `fix/improvements-and-fixes` sigue sin commitear. Se reparte en commits gitmoji en inglés, sin el trailer `Co-Authored-By`, agrupados por tema:

1. ✨ Proveedor `copilot_vscode` (issue #2).
2. 🐛 Lectura del WAL de SQLite.
3. ✨ Sincronización, etapas 0–1: identidad del dispositivo, `mergeSaves` e importar con Merge/Replace.
4. ✨ Rediseño de encuentros: ánimo, carácter, bayas, ataques, objetos encontrados, rastro de legendarios y cola de 30.
5. 💄 Rediseño de la interfaz: pantalla de combate, tienda, bolsa, Pokédex, ficha de entrenador y modo oscuro.
6. ✨ Terrenos por tipo con transición, y saldo con animación de cambio.
7. 🔧 `Makefile` y las mejoras del bench.

Incluye también el trabajo de @helper en la interfaz (fila del menú, placas con medidores, chips de riesgo, pasada de UX de la pantalla de combate, insignia del saldo), que va en el commit 5.

**Hallazgo al preparar el reparto:** Copilot, WAL y Makefile se separan limpiamente por fichero. Sincronización, encuentros, terrenos e interfaz están entrelazados en los mismos ficheros (`model.ts`, `store.ts`, `persistence.ts`, `saveTransfer.ts`, `extension.ts`, `dispatch.ts`, `build.ts`, `main.ts`); separarlos por tema exige partir cada fichero trozo a trozo y los commits intermedios no compilarían solos. Decisión pendiente de Diego: tres commits limpios + uno grande, o la serie por temas asumiendo que solo el último pasa `make check`. Se ejecuta `make check` sobre el árbol completo antes del primer commit y después del último. Al final se pregunta a Diego si quiere hacer push y abrir un PR.

---

## Modelo objetivo (lo que fijan todas las fases)

**Registro por especie.** Hay un mapa nuevo en `CompanionState`:

```ts
species: Record<number, SpeciesProgress>
// SpeciesProgress = {
//   xp: number /*int*/, unlocked: boolean, seen: boolean, registered: boolean,
//   caught: number, candiesUsed: number,
//   threshold?: number /* registerXP, fijado cuando su línea está cargada */, lineRarity?: Rarity,
//   pendingShare?: number /* 0..1: % de registro debido (captura sin línea); se aplica al fijar threshold */,
//   shinyXP?: number, shinyUnlocked?: boolean, shinyRegistered?: boolean,
// }
```

- **Requisito de registro de una especie:** `registerXP(sp)` = el umbral de su etapa dentro de su línea, con `PokemonBalance.phaseThreshold(rarity, k, i)`. Se **fija al desbloquear** (`threshold`) junto con la rareza de la **línea** (`lineRarity`), porque decodificar es síncrono y sin red. Dos rarezas conviven con nombres distintos: la del *encuentro* (por `captureRate` de la especie, como hoy: caducidad, robos, insignia) y la de la *línea* (registro, duplicados). Se reutiliza la fórmula sobre la escala nueva (C3). Una línea común de 3 formas pide 8M, 17M y 25M.
- **Estados en la Pokédex** (de menos a más):
  - *desconocido*;
  - *visto* (salió en estado salvaje; silueta con nombre);
  - *desbloqueado* (con su %);
  - *registrado* (100 %);
  - *shiny*.
- Los estados se derivan de **flags** (`seen`, `unlocked`, `registered`, `shinyUnlocked`, `shinyRegistered`), nunca de la xp: una fusión o una migración no pueden hacer retroceder la Pokédex. El panel lleva dos ejes: `status` (unknown | seen | unlocked | registered) y `shiny` (none | unlocked | registered).
- **La completitud de la Pokédex** cuenta especies registradas. **La Shinydex** cuenta shinies registradas.

**Compañero.** `active` pasa a ser «la especie elegida», o un huevo. La experiencia de cada fold se acredita **dentro de `applyUsage`, paso a paso**: llena `species[elegida].xp` hasta su `threshold`, y el sobrante arrastra a la forma siguiente (hoy `creditDelta` acredita todo el delta de golpe a `usedAtStage` y `applyUsage` resta por umbral; con dos destinos eso dejaría la especie anterior por encima de su umbral y la nueva a cero). `creditDelta` queda solo para el huevo y el saldo (doble uso: el saldo no cambia de fórmula). El Caramelo Raro entra por el mismo camino (`grow`). Al llegar a `threshold`:

- se marca *registrado*;
- se desbloquea la siguiente forma planificada (el plan de ramas actual, `pickPlannedChild`);
- el compañero pasa a esa forma.

En la última forma, la barra se queda llena y, a partir de ahí, la experiencia alimenta el progreso shiny (fase 5). **Ditto:** sigue entrando solo por el disfraz (1/128, está fuera del índice y del huevo); al revelarse, la xp acreditada a la especie disfrazada se mueve a `species[132]` con la rareza de la línea original, como hace hoy `revealedDitto`.

**Sin línea cargada (sin red, o en una fusión):** `applyUsage` devuelve pronto hoy si `line === undefined` y `mergeSaves` acredita con `creditDelta` sin línea, así que `threshold` no puede ser obligatorio. Regla: sin línea, `species[elegida].xp` acumula **en bruto** (como hoy `usedAtStage`), `registrationPercent` acota a 100 % y **nunca** marca `registered`; cuando `update` recarga la línea, `grow(0)` fija `threshold` y resuelve llenado y arrastre. `store.ts` pasa de `creditDelta` + `grow(0)` a `grow(delta)`, y `creditDelta` deja de escribir `active`; en la fusión el crédito va a `species[elegida del ganador].xp` en bruto (o al huevo).

**El huevo sigue siendo una opción de compañero**, y vive en un campo propio `egg?: { usage, tier?, pendingHatchID? }` independiente de `active` (hoy `sanitized` borra `eggTier` y `pendingHatchID` en cuanto hay un Pokémon activo, así que un huevo "en pausa" perdería su garantía). Al eclosionar desbloquea una especie aleatoria al 0 %, con preferencia por las que no tienes. **Cómo se consigue** (decisión de Diego): cada día se concede **un huevo gratuito**, acumulables hasta **3** (`eggStock: { count, lastGrantDay }`); incubar uno es una opción de compañero, de uno en uno, y cuesta 5M eclosionar. La concesión va junto a `noteAccrualDay`, con `observation.todayDate` (el core no llama a `todayKey`) y dentro de `delta > 0`: **solo un día con uso real da huevo**, como la racha. Decodificación: `count` entero acotado 0..3, `lastGrantDay` con forma de día como `lastStreakAwardDate`; sin clave → `{ count: 0 }`, sin regalar días pasados; `sanitized` acota. Fusión **fail-closed**: `count` del ganador y `lastGrantDay` el más reciente (un máximo resucitaría huevos ya incubados; así nunca se duplica el del día y como mucho se pierde uno). **Huevos de tienda:** `buyEgg(tier)` deja de descartar al compañero y de exigir `active` (hoy hace ambas cosas, shop.ts); requiere un huevo en incubación y le escribe `tier`; `eggGuarantee` lee `egg.tier`. No sustituye al inicial.

**Sincronización.** `mergeSaves` ya acredita al ganador los tokens que el perdedor acumuló (`unseenTokens` → `creditDelta`). Si `creditDelta` escribe en `species[elegida].xp`, esos tokens ya entran por ahí: hacer además «máximo por clave» con el mapa del perdedor los contaría dos veces. Por eso:

- `xp` y `shinyXP` vienen **enteros del ganador** más el crédito de la fusión, como hoy `active`;
- `unlocked`, `seen`, `registered`, `shinyUnlocked` y `shinyRegistered` se **unen** (OR) — así una especie que el perdedor registró nunca vuelve a "desbloqueada al 0 %" — y `caught` y `candiesUsed` se toman por **máximo**; `threshold`/`lineRarity`: el definido cuando solo un lado lo tiene; `pendingShare` por máximo (se borra al aplicarse);
- la xp que el perdedor puso en *otra* especie durante la bifurcación se pierde, igual que hoy se pierde su compañero. Se documenta y se fija en `companion-merge.test`.

El compañero elegido viene del lado ganador. `earnedTokens` (ver C6) viene del ganador, como `spentTokens`.

---

## Fases (cada una con su sub-plan antes de implementar)

### Fase 1 — Núcleo de registro por especie

- Tipo `SpeciesProgress`, el mapa `species` y `registerXP`.
- Decodificación tolerante (enteros, mapa por clave), `freshCompanionState`, `sanitized` (acotar por clave) y la regla de fusión en `merge.ts`.
- **Migración.** Al leer una partida sin `species`, se siembra desde `dex`, `collectedFinals` y `active`:
  - cada forma que aparece en `dex` (`chainOrder` de las líneas graduadas y las capturas `wild`) y en `collectedFinals` → `unlocked`, xp 0;
  - el compañero actual: todas las formas de `pathIDs` → `unlocked`, xp 0, y `usedAtStage` se pone a **0** (en la escala nueva, los 378M de Diego son ~1 h de juego; no merece acotados ni conversiones).

  Solo flags y ceros: no hace falta ningún umbral, así que la siembra es síncrona y sin red. Se siembra solo si falta la clave `species`, como `milestonesAwarded`, así que no hay recompensa retroactiva ni shiny retroactiva. **No hace falta subir `COMPANION_STATE_SCHEMA`:** `usedAtStage` se reinicia en la misma siembra, con lo que ningún valor antiguo se reinterpreta.
- **Estado *visto*:** se marca al aparecer un salvaje (`rollEncounter`).
- `collectedFinals` se mantiene en el save por compatibilidad, pero **sus cuatro consumidores** pasan a leer el conjunto de especies desbloqueadas en esta misma fase: `pickPlannedChild`/`makeEvolutionPlan`/`normalizedEvolutionState` (`growth.ts`, diversidad de ramas) y `chooseBaseFromIndex` (`pokeapi.ts`). Dejar de escribirlo sin cambiar los lectores rompería las ramas (Eevee).
- **Escala ÷ 15** (C3): `PokemonBalance.graduationTotal` pasa a 50M / 125M / 200M / 400M. Se actualizan los tests que fijan cifras.
- **Caramelo Raro** (C4): `rareCandyXP` = 25 % del `threshold` de la especie, `candiesUsed` con tope **2 por especie** (se renueva en cada forma: una línea de 3 admite 6), nunca sobre la barra shiny; descripción y pista en la bolsa.
- Helpers puros en un módulo nuevo `src/core/companion/registry.ts`: `registerXP`, `creditSpeciesXP`, `registrationPercent` y `seedRegistry`.
- **Ficheros:** `model.ts`, `persistence.ts`, `saveTransfer.ts`, `merge.ts`, `ledger.ts` (`creditDelta`), `store.ts`, `shop.ts`, `dispatch.ts` y `registry.ts`.
- **Sub-plan:** `docs/plans/01-registro-por-especie.md`.

### Fase 1b — Tabla de economía y simulador

- `EconomyBalance` en el core: una sola tabla con todas las fuentes (tokens observados, primer registro, duplicados, finds) y sumideros (tienda, rastro, robos, señuelo). Las fases siguientes añaden ahí sus constantes; nunca un literal suelto.
- `tools/economy-sim`: simula N días de un usuario ligero, medio e intenso (perfiles sacados del corpus real) y responde cuánto se tarda en registrar una línea, en llenar la Pokédex o en lograr una shiny, y si el saldo se infla.
- `docs/game-design.md` en el repo con el modelo de este plan y las constantes vigentes, como referencia común de los sub-planes.
- **Sub-plan:** `docs/plans/01b-economia-simulador.md`.

### Fase 2 — Compañero a elección, inicial y evolución por barra

- **Primer arranque:** pantalla de elegir inicial. La lista de iniciales de las gen 1–5 es una tabla en el core.
- **Acción `setCompanion`** (id de especie desbloqueada o `'egg'`), siguiendo el patrón ya trazado:
  1. `protocol.ts`: `PanelMessage`;
  2. `main.ts`: botón en el detalle de la Pokédex;
  3. `surface.ts`: `PanelRequestKind`;
  4. `extension.ts`: validación con `isOpaqueID` y `CHANGING_REQUESTS`;
  5. `scanWorker.ts`: `WorkerAction` → `commit(setCompanion(...))`;
  6. función pura en el core.
- **`growth.ts`:** «graduarse» pasa a significar «registrar y avanzar». `applyUsage` escribe en `species` en lugar de `usedAtStage`. Con la especie ya registrada: primero abre ramas pendientes, luego `shinyXP`. Se adapta a Caramelo Raro, a la regla de Ditto y al sobrante que pasa del huevo a la cría.
- **Huevo:** sigue costando 5M eclosionar; da una especie aleatoria **desbloqueada al 0 %** con preferencia por las que no tienes. Es la vía para abrir líneas que no te salen salvajes; los huevos de tienda con tier se mantienen.
- Interfaz: la placa del jugador y la barra de estado (`snapshot.ts`) muestran el % de registro; la Pokédex muestra los estados y el botón «Elegir como compañero».
- **Sub-plan:** `docs/plans/02-companero-a-eleccion.md`.

### Fase 3 — Capturar = registrar

- Capturar: desbloquea la especie y suma el **5 %** de `registerXP`. Esto sustituye al registro `wild` aislado; el historial de capturas se mantiene.
- Duplicado: recompensa en tokens, calibrada con el simulador de la fase 1b.
- Texto del resultado de la captura con el % ganado y la recompensa (`dispatch.ts`).
- Mejoras de UI pedidas por Diego (2026-10-20), detalladas en el sub-plan § Mejoras de UI:
  - barra de EXP al estilo de los juegos, con lo que lleva y lo que le queda integrado y del mismo color;
  - aviso de captura como el de subir de nivel, en la zona del salvaje: el % de registro sumado y si es nuevo en la Pokédex;
  - una Poké Ball en la tarjeta del salvaje si ya lo tienes, como en los juegos.
- **Sub-plan:** `docs/plans/03-capturar-registra.md`.

### Fase 3b — Salvajes con formas evolucionadas

- Hoy `baseSpeciesIndex` solo contiene inicios de línea y `chooseBaseFromIndex` sortea entre ellos. Hay que sortear la **línea** y después la **etapa**: 65/30/5 en líneas de 3 etapas, 75/25 en las de 2, 100 en las de una. Las líneas vienen de `EvoLine` (PokéAPI); se decide en el sub-plan si el índice en disco guarda la cadena o se pide al aparecer.
- **Incentivo a lo que no tienes:** peso extra a especies sin desbloquear, y menor a las registradas (hoy solo se halva lo ya capturado). Se calibra con el simulador: capturar un Charizard al 5 % se salta 25M de xp (escala nueva), y eso tiene que estar pagado por la rareza de que aparezca.
- Ramas: una etapa con varias formas (Eevee) elige entre ellas con peso uniforme, favoreciendo las no desbloqueadas.
- Con esto el señuelo (fase 6) puede apuntar a cualquier especie, no solo a las base.
- **Sub-plan:** `docs/plans/03b-salvajes-evolucionados.md`.

### Fase 4 — Calibración de precios

- Reajustar los precios (balls, huevos, Caramelo Raro, Amuleto Iris) y las recompensas con los datos del simulador, y fijarlos en tests como ya se hace con la tabla de captura.
- **Sub-plan:** `docs/plans/04-calibracion-precios.md`.

### Fase 5 — Shiny por experiencia y Shinydex

- Una barra (ver C5): con la especie registrada como compañero, la experiencia va a `shinyXP` hasta `8 × registerXP`; capturar o eclosionar un shiny la completa al instante. Entonces se puede «vestir».
- **Impulso shiny:** tokens del monedero aceleran la barra 1:1 hasta la mitad del requisito. El sub-plan fija el tope, el cambio y el papel del Amuleto Iris con el simulador.
- **Sub-plan:** `docs/plans/05-shiny.md`.
- Pestaña o segmento **Shinydex** en la Pokédex.

### Fase 6 — Señuelo (apuntar a una especie)

- Elegir una especie *vista* o *desconocida* no desbloqueada como objetivo. Su peso de aparición se multiplica en el sorteo de la fase 3b (hoy el mapa `weights` en `pokeapi.ts:493`).
- Coste y duración (¿objeto de la tienda?, ¿tokens por día?) se deciden en el sub-plan, con el simulador de la fase 1b.
- **Sub-plan:** `docs/plans/06-senuelo.md`.

### Fase 7 — Ideas de diseño (para priorizar con Diego)

- **Medallas e hitos:** «10 especies registradas», «primera shiny», «una línea completa».
- **Retos diarios o semanales:** «captura un tipo fuego», «registra un 5 %», con recompensa en tokens. Usan los tipos que ya guardamos.
- **Amistad del compañero:** sube con los días seguidos como compañero (la racha ya existe) y da un pequeño bonus de experiencia.
- **Regiones:** completar por generación (gen 1–5) con su insignia; la Pokédex ya se puede filtrar por rango de id.
- **Tabla de tipos en los encuentros:** el tipo del compañero contra el del salvaje modifica la captura o el ánimo (los tipos ya están guardados).
- **Guardería:** dejar un segundo Pokémon que gana un % pequeño de experiencia pasiva.
- **Sub-plan:** `docs/plans/07-ideas.md`.

---

## Riesgos y reglas transversales

- **Sincronización:** cada campo nuevo necesita su regla en `mergeSaves` y en `sanitized`, con un test de fusión.
- **Enteros:** `isNumberRecord` descarta el mapa entero si un valor no es entero. `species` se decodifica entrada a entrada.
- **Sin recompensas retroactivas:** cualquier valor derivado se siembra solo cuando falta la clave.
- **`COMPANION_STATE_SCHEMA`:** hoy es 2 y no cambia en la fase 1 (la migración reinicia `usedAtStage` en vez de reinterpretarlo). La fase 2 elimina el campo y cambia la forma de `active`; decide entonces si sube a 3.
- **Monedero en un solo sitio:** `usedSinceInstall − spentTokens` se calcula hoy en tres lugares (`spendableBalance` en `ledger.ts`, `stealAmount` y `trackLegendary` en `encounters.ts`). Al añadir `earnedTokens` (fase 1) los tres pasan por `spendableBalance`, con un test que lo fije.
- **Textos:** todos van a `dispatch.ts` en ko/en/ja/es.
- **Sprites:** se siguen pidiendo en tiempo de ejecución.

## Verificación (cada fase)

- **Tests unitarios.** Primero el test, luego se inyecta el defecto y se comprueba que falla. Ficheros:
  - `companion-growth`, `companion-store`, `companion-merge`, `save-transfer`, `panel-build` y `dex-view`;
  - uno nuevo, `companion-registry`.
- **`make check`** y **`make e2e`**.
- **Bench:** script de interacción (Playwright) para la Pokédex y la elección de compañero, con capturas en claro y oscuro de 280 a 600 px.
- **Escenarios de desarrollo** nuevos en `src/core/dev/scenarios.ts`:
  - dar experiencia a la especie;
  - registrar al instante;
  - desbloquear la shiny;
  - forzar el estado *visto*.
- **Prueba manual** de Diego con `make dev`.
- **Migración:** cargar una copia de su partida real en `.dev-state` y comprobar que las 45 especies quedan desbloqueadas al 0 %, que Gyarados sigue de compañero al 0 % y que el saldo y el historial no cambian.
