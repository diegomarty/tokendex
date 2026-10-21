# Plan 9 — pulido antes de la 1.0.0

> Hereda las reglas de
> `CLAUDE.md` y del plan 08: test primero con inyección de defecto, el núcleo emite el texto ya
> formateado, la webview no formatea números, commits gitmoji en una línea sin trailer, sin push.

## Contexto

Diego ha probado la 0.6.0 preparada y pide, antes de publicar: que la versión sea **1.0.0**, que
las cabeceras de pestaña se parezcan a la tapa de Inicio, comprar packs de 10 en múltiplos (×10…×100),
los filtros de la Pokédex dentro del aparato, el cajón Salvajes en filas, el diálogo de combate
escrito letra a letra como el de la Bolsa, y la pestaña Objetos de la Bolsa siempre activa.

Decisiones de Diego (21 oct): 1.0.0 puesta a mano; el listado es el cajón Salvajes; Objetos
siempre activa (con estado vacío si no hay nada).

## Reparto

- **Yo (núcleo, protocolo, host, tests, versión):** 9.0, 9.1-núcleo, 9.4-núcleo, 9.6-núcleo.
- **@helper (webview, CSS, bancos):** 9.2, 9.3, 9.1-UI, 9.4-UI, 9.5, 9.6-UI. Se le manda el
  contrato de protocolo de cada punto antes de empezar; no commitea, commiteo yo.

## 9.0 Versión 1.0.0 (yo, primero)

- Quitar el commit local `ce0571d` (🔖 0.6.0; está en HEAD y sin push): `git reset --hard HEAD~1`
  tras comprobar `git status` limpio.
- `npm version 1.0.0 --no-git-tag-version` y commit `🔖 Set the version to 1.0.0 for the release`
  (nunca el prefijo `🔖 Bump the version to`, que `bump.yml` salta).
- Por qué funciona: `next-version.sh` calcula 0.6.0 desde `v0.5.0`, no supera a 1.0.0 y mantiene
  `NEXT=1.0.0` (L214-222); sin tag y con notas → `release`; `release.yml` compara tag y
  `package.json` (L41-48) y coinciden. Verificar con `.github/scripts/next-version.sh` →
  `next=1.0.0 tagged=no` y `changelog.sh has-notes` → `notes=yes`.
- Al final del plan, añadir al CHANGELOG `[Unreleased]` las notas de este plan.

## 9.1 Tienda: packs de ×10 con multiplicador ▲▼ (1…10 → ×10…×100)

Núcleo (yo):
- `model.ts` `Pokeball`: `bundleMaxPacks: 10`. `shopEntryPrice` ya escala con cualquier cantidad
  (el descuento es por unidad), no cambia.
- `build.ts` L250-267: la acción del pack lleva `packs: PanelShopPack[]` (n = 1…10), cada uno
  `{ id: item:<kind>:<10n>, text: ×<10n>, label (bundleBuyLabel), confirmTitle, priceText, price,
  saveText, enabled: canBuyItem(state, kind, 10n) }`. El primero coincide con la acción actual.
- `protocol.ts`: `PanelShopPack` y `PanelShopAction.packs?`.
- `extension.ts` `parseEntryID` L533-546: aceptar `quantity = bundleSize × n`, n entero 1…max;
  cualquier otra cosa sigue fallando cerrado (actualizar el comentario L525-531).
- `shop.ts` `shopEntries()` sin cambios salvo si un test lo pide. Confirmación nativa igual.
- Tests: `panel-build` (10 packs, precios = `shopEntryPrice`, enabled por saldo), `parseEntryID`
  (×30 vale, ×25 / ×110 / ×0 / pack de Master Ball no). Inyectar: aceptar ×25 → falla.

UI (@helper): en la fila del pack, un selector ▲▼ junto al botón ×10 que recorre `packs`
(sin calcular nada: cambia `data-buy/title/price`, el texto y el precio del botón por los del pack
elegido). Teclado (flechas), `aria-label` del núcleo, el ▲ se apaga en ×100 y el ▼ en ×10; el
multiplicador elegido se guarda como vista y se reinicia al comprar.

## 9.2 Cabeceras de pestaña como la tapa (@helper)

`dexHead` (main.ts 1812) y la cabecera de la tienda (1301) adoptan la estructura de la tapa
(`renderHome` 383-423): lente + tres luces + título con el estilo de marca (`.brand-name`) +
pantalla LCD a la derecha (`.wallet-badge.lcd`). Pokédex: el «21 / 649» va en la LCD y la barra
de progreso fina bajo la fila, dentro de la carcasa. Tienda: el saldo en la LCD (ya está).
Diego (21 oct): la cabecera de la Tienda también, y los títulos «TIENDA» y «POKÉDEX» con el estilo
exacto de `.brand-name` (amarillo cursiva con trazo azul) y en mayúsculas (`text-transform`, el
núcleo no cambia el texto). Todo alineado al centro vertical con la misma altura y rellenos que la tapa (`.wallet-bar`
4065). Una sola regla de CSS compartida para las tres cabeceras; `test/styles.test.ts` lo fija.

## 9.3 Filtros de la Pokédex dentro del aparato (@helper)

Los segmentos (Colección · Shinydex · Medallas · Historial), el buscador, el orden, «Solo
obtenidos» y las regiones pasan dentro de la carcasa roja de la Pokédex, como la pantalla de la
tapa (`.lid-screen` 4997): los segmentos como botones del aparato en la fila de la cabecera y,
debajo, una pantalla LCD con el buscador y el orden con aspecto LCD, y los chips de región y
«Solo obtenidos». Se pliega con el chevrón como la tapa (abierta por defecto). Conservar foco y
cursor de `#dex-search` en los repintados (mecanismo actual). Sin cambios de núcleo.

## 9.4 Cajón Salvajes en filas: los 3 siguientes y «+X esperando»

Núcleo (yo): `PanelWild.queueMoreText?` = `D.moreWaitingText(lang, n − 3)` cuando hay más de 3
(revisar la redacción de `moreWaitingText`, hoy sin uso, y que diga «+X esperando»); constante
`WILD_QUEUE_SHOWN = 3` en el núcleo. Test con 3 y con 4 en cola (límite).

UI (@helper): `renderWildQueue` (1131) pinta solo los 3 primeros, cada uno en su fila a todo el
ancho (sprite, nombre, ✨, rareza), y una última fila con `queueMoreText`. Fuera la cuadrícula
`auto-fill` (5266) que no encaja; sin scroll interno.

## 9.5 El diálogo de combate se escribe letra a letra (@helper)

Causa (main.ts `typeDialogs` 3148-3206): `writtenLines` va por texto y «¿Qué vas a hacer?» es
siempre el mismo, así que tras la primera vez nunca se reescribe; además el bucle recorre
secciones ocultas y una línea vieja en otra pestaña adelanta a la visible. Arreglo: la clave es
la línea **en su contexto** (`encounterID` + texto para el combate, `item` + texto en la bolsa,
vía `data-line`), solo diálogos de la sección visible, y el resultado de un lanzamiento que ya se
mostró entero no se reescribe. Banco: dos encuentros seguidos → el prompt se escribe en ambos;
cambiar de pestaña y volver no lo reescribe. Inyectar la clave por texto → el banco falla.

## 9.6 Bolsa: «Objetos» siempre activa

Núcleo (yo): `PanelStrings.emptyPocket` (o `emptyState(lang, 'items')`) en `dispatch.ts`: «Aún no
tienes objetos. Caramelos Raros, Mentas y el Amuleto Iris están en la tienda», con acción «Ir a
la tienda» (`emptyBagAction`). El Amuleto Iris ya va a `items` cuando se tiene (build.ts 339).

UI (@helper): ninguna bolsillo se deshabilita (1379); un bolsillo vacío muestra ese estado vacío
con el botón a la tienda.

## 9.7 La ficha de especie como una entrada de Pokédex (Diego, 21 oct)

La ficha (`speciesCard`, la misma desde el botón Pokémon del combate, la Pokédex, la Shinydex y la
caja del PC) hoy es un contenedor con barra y estado. Pasa a ser una **entrada de Pokédex**, y con
más datos de PokéAPI que ya descargamos y tirábamos.

Núcleo (yo):
- `pokeapi.ts`: `SpeciesDTO` lee `genera` y `flavor_text_entries`; `/pokemon/{id}` lee `height` y
  `weight`. Nuevo `dexDetails(id)`: categoría y descripción por idioma (la entrada más reciente de
  cada idioma; japonés en kana `ja-Hrkt` como el resto de la UI; espacios y `\f` limpios), altura,
  peso, tipos, estadísticas base y ratio de captura. Caché en memoria y en disco
  (`dex-details.json`, con versión), para que una ficha vista se abra sin red. La línea evolutiva
  sale de `line(id)`, que ya existe y funciona desde cualquier forma.
- `src/core/panel/dexEntry.ts`: `PanelDexEntry` ya formateado: `genusText`, `flavorText`,
  `heightText`/`weightText` con la marca decimal del idioma, `types` (`{id, label}`), `stats`
  (`{key, label, value, percent}` sobre 255, nombres de los juegos: PS, Ataque, Defensa, At. Esp.,
  Def. Esp., Velocidad) y `statTotalText`, `line` (`{id, name, status, isThis}` con «???» para lo
  no visto), y `unavailableText` si no hay red ni caché. Como en los juegos, una especie solo
  **vista** muestra categoría y tipos; la descripción, medidas y estadísticas llegan al obtenerla
  (con una línea que lo dice).
- Petición bajo demanda: webview `{type:'dexEntry', speciesID}` → host → worker (fuera de la cola
  serializada, es solo lectura y red) → respuesta → host `{type:'dexEntry', entry}` a la superficie
  que la pidió. Nunca dentro de `PanelState`.
- Tests: parseo de la DTO (idioma, kana, limpieza, más reciente), caché en disco sin red, vista vs
  obtenida, formato decimal es/en, nombres no vistos ocultos.

UI (@helper): la ficha como un aparato: cabecera roja con lente y luces, número y nombre en la
tapa; a la izquierda una pantalla LCD con cuadrícula con el sprite (animado; shiny si está
registrada); a la derecha la categoría, los tipos como insignias de color, altura y peso en
lecturas LCD; la descripción en el cuadro de diálogo escrita letra a letra (`typeDialogs`); las
estadísticas en barras (`gameMeter`); la línea evolutiva con sprites y silueta para lo no visto
(clic abre esa ficha); y debajo la parte de juego que ya existe (registro, shiny, señuelo, elegir
compañero). Mientras llega la entrada, un estado de carga; sin red, `unavailableText`.

## 9.8 La caja del PC: más filtros y orden ascendente/descendente (Diego, 21 oct)

Hoy la caja solo tiene buscador y orden. Núcleo (yo): `PanelPCBox.filters` (Registrados · Sin
registrar · Shiny, con su texto), y `PanelStrings.sortAscending/sortDescending` para el botón de
dirección; las regiones son las de la Pokédex (`dexSummary.regions`, con `from`/`to`). UI
(@helper): en `listTools` (compartido por la Pokédex y la caja) un botón ▲▼ que invierte el orden
elegido, con su `aria-label`; en la caja, los chips de región y de estado como en la Pokédex. La
dirección se guarda como vista.

## 9.9 Bug: la tarjeta de captura de una especie registrada (Diego, 21 oct)

En «¡Nuevo en la Pokédex!» con la especie registrada, el texto verde que decía el registro es ahora
una píldora verde vacía (se ve el fondo de `.tag` sin su texto). @helper: localizar qué campo de
`catchBanner`/`PanelNews` pinta esa línea, devolverle su texto legible y fijarlo en un banco.

## 9.10 Todas las barras de experiencia con el diseño de la placa del compañero (Diego, 21 oct)

La barra de EXP de la placa del compañero en Inicio (marco oscuro, etiqueta «EXP», relleno azul)
pasa a ser la de toda barra de experiencia o registro: tarjeta de captura, ficha de especie, caja
del PC, Pokédex, noticias. Una sola pieza (`gameMeter` en su variante EXP) y `styles.test` lo fija.
@helper; si hace falta texto nuevo del núcleo, me pasa el campo.

## 9.11 La Shinydex, rehecha (Diego, 21 oct, vía @helper)

1. Los chips de región cuentan shinies, no registros (núcleo: `PanelRegion.shinyRegistered`,
   `shinyPercent`, `shinyProgressText`; yo). 2. Solo se ven las shinies registradas; el resto,
   silueta. 3. El scroll es solo de la lista. 4. Cambiar entre Colección y Shinydex conserva la
   posición. 5. Una celda más vistosa y con más datos (rareza, porcentaje, compañero, criando; los
   tipos no, que exigirían una petición a PokéAPI por celda). 2–5: @helper.

## Orden

1. 9.0 versión (yo). 2. Mando a @helper 9.2, 9.3, 9.5 (sin núcleo) en paralelo. 3. Núcleo de 9.1,
9.4, 9.6 → contratos a @helper → su UI. 4. Commits por punto. 5. CHANGELOG + README si cambian
capturas (`make shots`, `make hero`), `make package`.

## Verificación

- `make check` (tests, tsc, Prettier) y `make e2e` en verde.
- Bancos de @helper en oscuro/claro × 280/360/600: cabeceras alineadas (capturas comparadas con
  la tapa), filtros dentro de la carcasa sin desbordar, stepper ×10…×100, cajón Salvajes con
  4+ en cola, diálogo escribiéndose en dos encuentros seguidos, bolsa sin objetos.
- `next-version.sh` → `next=1.0.0`, `changelog.sh has-notes` → `notes=yes`; `make package` →
  `tokendex-1.0.0.vsix` sin sprites.
