# Fase 8 — Una sola interfaz: el aparato, el papel y el contador

**Plan maestro:** `00-master.md`, nueva fase tras la 7 (pedida por Diego el 2026-10-21).
**Estado:** borrador con auditoría. Se detalla en modo plan antes de implementar.
**Depende de:** fases 1–3b (la interfaz que unifica ya existe) y, para la barra shiny y el botón de impulso, la fase 5. Independiente del core: no cambia `PanelState` salvo donde se indica.
**Responsable propuesto:** @helper (webview, bench), con revisión de «main».

## Objetivo

Que la extensión se lea como **un mismo concepto**: un Pokédex que llevas en el editor. Hoy cada pantalla resolvió su aspecto por su cuenta (el saldo, la tienda, el cartel de registro, la Pokédex) y el resultado funciona, pero se notan las costuras: cuatro carcasas rojas, dos estilos de pantalla LCD, seis barras distintas, botones de VS Code en medio del juego y once tamaños de letra. La fase no añade funciones: convierte lo que hay en un sistema de piezas, con reglas escritas, para que cada pantalla nueva salga coherente sin pensarlo.

## Auditoría (2026-10-21, `src/webview/styles.css` 4615 líneas, `main.ts` 2177)

| Medida | Hoy | Comentario |
|---|---|---|
| Colores hexadecimales distintos | **197** (+74 `rgb()` literales) | Solo ~20 son tokens (`--ink`, `--paper`, `--exp`, `--dex-red`…). El resto son literales repetidos: `#0d2228`/`#8dffb0` (LCD) ×4, `#6e1c17` (carcasa) ×2, `#11161e`/`#10151d` (carril) ×2 cada uno. |
| Tamaños de letra | **36 valores** (9–54 px y 0,68–1,5 em) | Mezcla de px y em; 8,5 / 9 / 9,5 / 10 / 10,5 / 11 / 12 / 12,5 px conviven. |
| Radios de borde | **20 valores** | 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14 px, 999 px y cuatro asimétricos. |
| Selectores redefinidos a nivel raíz | **27** | `.shop-wallet .value` ×4, `.shop-wallet` ×3, `.segments*`, `.dex-detail`, `.throw-ball` ×4… Capas antiguas que la siguiente pisa; el resultado depende del orden. |
| Barras de progreso | **6 estilos** | Ánimo (casillas), EXP (carril oscuro), registro en celda, registro en el cartel, «próximo encuentro» (diálogo), límites oficiales. |
| Botones | **5 familias** | `.action` (azul de VS Code), `.action.priced` (LCD), `.command` (menú de combate), `.dialog-action` (diálogo), chips/segmentos. El azul de VS Code aparece dentro del juego: incubar, elegir compañero, confirmar inicial. |
| Pastillas | **8 variantes** | Rareza, estados (Razz/−4M), % del panel, riesgo, «esperando», −10 %, +5 %, recuento de bolas. Radios y alturas distintos. |
| Duraciones de animación | **15 valores** | 120–900 ms sin escala; cada efecto eligió la suya. |
| Media/container queries | 6 `@media` de ancho + 3 `@container` | Umbrales 250/300/310/320/420/560/640 sin nombre común. |

## Concepto: tres capas

Toda la interfaz pertenece a una de tres capas, y cada capa tiene **una** regla de tema:

1. **El aparato** — el Pokédex físico: carcasa roja, lente, luces, pantallas LCD. **Fijo en todos los temas** (un objeto no cambia de color con el editor). Dónde: tapa de Inicio, cabecera de la Pokédex, ficha de detalle, cartel de registro, saldo de la tienda, etiquetas de precio, barra EXP.
2. **El papel** — lo que los juegos dibujan en pantalla: paneles de combate, diálogo, menú, bolsa, tarjetas. **Sigue el tema** (`--paper`/`--ink` cambian en oscuro). Dónde: placas, menú de combate, diálogo, bolsa, tienda (filas), Pokédex (celdas), ajustes del entrenador.
3. **El contador** — la herramienta de uso: totales, límites oficiales, tabla por CLI, Ajustes técnicos. **Nativo de VS Code** (tokens `--vscode-*`), para que se lea como parte del editor.

Regla de oro: **ningún componente mezcla capas**. Un botón dentro del papel es de papel; el azul de VS Code solo vive en el contador. Hoy la rompen: «Incubar un huevo», «Elegir como compañero», confirmar inicial, `.action` del rastro de legendarios.

## Diseño

### 1. Tokens (una sola fuente de color, tamaño y tiempo)

Un bloque `:root` al principio de `styles.css`, por capas, y **cero literales de color fuera de él** (salvo los terrenos, que ya son tokens por escena):

- **Aparato:** `--device-casing`, `--device-casing-deep`, `--device-casing-edge`, `--device-lens-*`, `--device-led-red|amber|green`, `--lcd-dark-bg`, `--lcd-dark-glass`, `--lcd-dark-ink` (verde fósforo), `--lcd-light-bg`, `--lcd-light-ink`, `--lcd-bezel`, `--track` (carril de barras).
- **Papel:** los actuales `--paper`, `--ink`, `--paper-edge`, `--paper-link`, `--paper-field` (+ su versión oscura, ya existe).
- **Juego:** `--exp`, `--anger`, `--nerves`, `--trust`, `--rarity-*`, `--gain` (verde de «+5 %», «+2M», «−10 %»), `--loss`.
- **Escala tipográfica (5):** `--fs-xs 10px` · `--fs-s 11px` · `--fs-m 12.5px` · `--fs-l 14px` · `--fs-xl 17px`. Los tamaños grandes (título del inicial, saldo) se quedan como excepción con nombre.
- **Radios (4):** `--r-s 4px` (pista, casilla) · `--r-m 7px` (botón, fila) · `--r-l 10px` (tarjeta, placa) · `--r-pill 999px`. Las placas conservan su esquina recortada como **forma con nombre** (`--r-plate`).
- **Tiempo (3 + curva):** `--t-fast 120ms` (hover), `--t-mid 300ms` (cambios de estado), `--t-slow 600ms` (entradas), `--ease-out`, `--ease-pop` (rebote). Las secuencias largas (captura, registro) se escriben en múltiplos de estas.
- **Anchos con nombre:** `--w-narrow 300px`, `--w-wide 560px` para los container queries (hoy 250/300/310/320).

Mecanismo para que no vuelva: un test en `test/` que lea `styles.css` (como ya hace `scene-geometry.test.ts`) y falle si aparece un color literal fuera del bloque de tokens o de los terrenos, o un `font-size` fuera de la escala.

### 2. Piezas del aparato (`device-*`)

- **`.device-casing`**: carcasa roja con borde, brillo superior y sombra interior. Variantes por contenido: tapa (Inicio), cabecera (Pokédex), ficha (detalle), tarjeta (cartel). Hoy son cuatro reglas con sus colores copiados.
- **`.device-lights`**: lente + tres LEDs, una sola pieza (hoy `.brand-lens`/`.brand-leds` y `.dex-lens` por separado).
- **`.lcd`** con dos variantes: `.lcd.dark` (saldo, precios, barra EXP) y `.lcd.light` (pantalla del cartel, futura ficha de detalle). Mismas líneas de barrido, mismo bisel, misma tipografía tabular. Hoy: saldo y precios comparten literales copiados; el cartel tiene su propio verde.
- **El Nugget** con una sola clase y un solo recorte (hoy hay tres márgenes distintos según dónde aparece).

### 3. Una barra de juego (`.meter`)

Un componente, tres decisiones en clases:

- **Relleno:** `continuous` (EXP, registro, próximo encuentro) o `cells` (ánimo; 10 o 5 casillas).
- **Superficie:** `on-device` (carril oscuro con borde, como EXP) o `on-paper` (carril de tinta al 14 %).
- **Color:** `--meter-tone` (EXP, ánimo por clave, verde de registrado).

Y dos extras que hoy están sueltos: el **tramo ganado** (`.meter-gain`, el blanco que se vuelve azul del cartel) reutilizable para cualquier subida, y la **etiqueta integrada** (`EXP` a la izquierda). Los límites oficiales se quedan en la capa del contador, con su barra nativa.

Efecto: la barra EXP del panel, la del cartel y la de la ficha de la Pokédex pasan a ser la misma barra, y la subida de un 5 % se anima igual en todas partes.

La fase 5 (shiny) añade una **barra shiny** en la ficha de la Pokédex y un **botón de impulso** que paga con el monedero: nacen como variante de esta pieza (`--meter-tone` dorado, superficie `on-device`) y del botón de aparato del punto 4, no como estilos propios. Si la fase 5 llega antes que esta, se implementa ya con las clases de destino para no tener que migrarla después.

### 4. Botones por capa

- **Papel:** `.btn` (tinta sobre papel, invierte al pasar el ratón; el que ya usan las etiquetas de la tienda antiguas) y `.btn.primary` (tinta llena). Sustituye a `.action` dentro del juego: incubar, elegir compañero, confirmar inicial, rastrear legendario, usar en la bolsa.
- **Aparato:** `.btn.lcd` (las etiquetas de precio de la tienda, ya hechas) y botones físicos del Pokédex si aparecen (redondos, en la carcasa).
- **Menú de combate:** `.command` se queda (es el lenguaje de los juegos), pero hereda tamaño, foco y cursor ▸ de la misma base.
- **Contador:** `.action` nativo, solo en Ajustes técnicos y en el contador.

Todos con el mismo anillo de foco (`--vscode-focusBorder`), el mismo estado deshabilitado y el mismo tamaño mínimo táctil (28 px de alto).

### 5. Pastillas y etiquetas

Una pieza `.tag` con tres tamaños (`xs` dentro de una placa, `s` normal, `m` titular) y semántica por color: rareza, estado, ganancia (`--gain`), pérdida (`--loss`), neutro. Sustituye a las ocho variantes. El `−10 %` de la tienda, el `+5 %` del cartel y el `+2M` del chip del saldo pasan a ser la misma etiqueta de ganancia.

### 6. Panel estrecho (≤ 300 px)

- Un único umbral con nombre (`--w-narrow`) y un único `@container` por zona (escena, menú, tienda).
- Placa del jugador: a ese ancho la pastilla de % desaparece (ya lo dice la barra EXP debajo) y el nombre recupera el espacio; ⓘ se queda.
- Placa salvaje: el nombre nunca comparte línea con más de un icono.
- Escena estrecha: con las placas más bajas que hay hoy, reajustar alturas (queda hueco arriba; pendiente desde la pasada de UX de la fase de combate). Cambia la geometría fijada en `test/scene-geometry.test.ts`: test primero.
- Botones del menú, huevos y tienda: dos columnas como máximo; nunca texto cortado (hoy se garantiza caso a caso).

### 7. UX: que el concepto se note

Además de unificar, cosas que dan «cuerpo» sin funciones nuevas:

- **Un mismo lenguaje de celebración.** Captura nueva, duplicado, eclosión, evolución, registro completo y cambio de compañero usan hoy toasts, cartel o nada. Propuesta: el **cartel del Pokédex** (ya hecho para la captura) como pieza única de «noticia», con variantes por evento; el toast de VS Code solo cuando el panel no está a la vista.
- **Transiciones entre pestañas** coherentes: hoy el cambio es seco. Un fundido corto (`--t-mid`) y nada más; respeta `prefers-reduced-motion`.
- **Estados vacíos** con el mismo patrón (silueta + una línea + una acción): bolsa vacía, Pokédex vacía, sin balls, sin huevos.
- **La pestaña es un botón del aparato** (decidido). La tira de pestañas pasa a ser la fila de botones del Pokédex, sobre la carcasa, y la pestaña activa es el botón «encendido». Los iconos son **objetos del juego** servidos por PokéAPI en tiempo de ejecución (nunca empaquetados, como el resto de sprites): propuesta Inicio → `town-map`, Tienda → `coin-case`, Bolsa → `explorer-kit`, Pokédex → `poke-radar`, Ajustes → `vs-seeker` (todos comprobados: existen en `sprites/items/`). Se ven a su tamaño nativo de 30 px; si un sprite no carga, se queda el codicon actual. El nombre de la pestaña sigue siendo su nombre accesible y su tooltip (ya localizado en el core). El mapeo se valida con capturas.
- **Escritura en pantalla** (decidido: sí, rápida). El diálogo de combate escribe su texto letra a letra como en los juegos, a ~60 caracteres por segundo (una línea larga en menos de un segundo y medio); un clic o una tecla lo completan al instante. La región `aria-live` recibe el texto completo de una vez, nunca letra a letra. Con `prefers-reduced-motion`, el texto aparece entero.
- **Microcopys**: revisar que cada botón diga lo que hace con el verbo del juego (ya se quitó «Comprar» donde sobraba).

## Fuera de alcance

Funciones nuevas (medallas, retos, regiones: fase 7), cambios de economía, el contador de uso (salvo que siga siendo nativo) y cualquier cambio del core que no sea una etiqueta ya formateada.

## Orden propuesto (entregable a entregable)

1. **Tokens + test de literales** (sin cambio visual: sustituir literales por tokens, borrar los 27 selectores repetidos). Captura antes/después idéntica en el bench.
2. **Aparato:** `.device-casing`, `.device-lights`, `.lcd` y Nugget.
3. **Barra única** `.meter` + `.meter-gain`.
4. **Botones por capa** y **`.tag`**.
5. **Estrecho** (con el cambio de geometría y su test).
6. **UX:** lenguaje de celebración, transiciones, estados vacíos; los opcionales con capturas para que Diego decida.

Cada paso: `make check`, bench claro/oscuro a 280/360/600 y alto contraste, `prefers-reduced-motion`, y capturas antes/después.

## Verificación

- Test de estilo (nuevo, junto a `scene-geometry.test.ts`): sin colores literales fuera de los tokens y terrenos; `font-size` solo de la escala; sin selectores redefinidos a nivel raíz. Inyectar un `#123456` suelto y ver que falla.
- Bench: los drivers actuales (`ux`, `shop`, `phase2`, `phase3b/d/f`, `evolved`, `wallet2`) deben pasar sin cambios en lo que miden; las capturas cambian solo donde el paso lo pretende.
- e2e y prueba manual en `make dev`.
- Métrica de éxito: colores literales 197 → < 30 (todos con nombre), tamaños de letra 36 → 5 (+ excepciones con nombre), radios 20 → 4 + forma de placa, familias de botón 5 → 3 por capa, barras 6 → 1 componente + la nativa.

## Decisiones (Diego, 2026-10-21)

- **Pestañas:** botones del aparato, con iconos de objetos del juego (punto 7).
- **Diálogo:** letra a letra, rápido (punto 7).
- **Frontera juego / contador** (delegada en @helper): el contador se queda **nativo de VS Code** y la frontera la marca el propio aparato. La zona de juego de Inicio (tapa, escena, diálogo, menú, huevos) se cierra con una **bisagra**: la franja inferior de la carcasa del Pokédex, como la bisagra del aparato de los juegos, que separa visualmente «el aparato» de «la hoja» de debajo. Bajo ella, el contador lleva un título de sección nativo («Uso»; cadena nueva en `dispatch.ts`, emitida por el core) y nada de papel ni de carcasa. Así la página no cambia de producto a mitad: se cierra el aparato y empieza la herramienta. En la tarjeta compacta del Explorador no hay bisagra (no hay contador debajo).

## Preguntas abiertas

- El mapeo exacto de iconos de pestaña, a elegir sobre capturas.
- Velocidad final del texto (60 c/s de partida) tras probarla en `make dev`.
