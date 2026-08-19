---
summary: "Reescritura a extensión de VS Code en TypeScript puro — un solo .vsix multiplataforma, sin binarios nativos. Plan por fases y mecanismo de seguimiento del Swift upstream."
read_when:
  - Trabajando en cualquier fase del port a extensión de VS Code
  - Portando un parser de Swift a TypeScript (leer §2 antes de escribir código)
  - Sincronizando cambios de upstream hacia el TypeScript (§8)
  - Tocando el escaneo, la caché incremental o el rendimiento del extension host
  - Empaquetando o publicando el `.vsix`
---

# Notas del port

> El plan por fases descrito aquí **está completado**. Se conserva porque documenta las
> mediciones y las decisiones que siguen gobernando el código.

Fork de `chattymin/PokeTokenBar` en `12d4218`.

**Objetivo:** una extensión de VS Code que funcione bien **en todas las plataformas** y que
pueda usar cualquiera.

> **Decisiones tomadas (2026-08-19)**
> 1. `Core` se **reescribe en TypeScript**. Se revierte la decisión anterior de compartir el
>    Swift por compilación. Razón en §0.2.
> 2. El árbol Swift **se conserva en el repo** — no como target de compilación, sino como
>    **implementación de referencia** contra la que se portan los cambios de upstream (§8).
> 3. **Cero binarios nativos.** Un solo `.vsix` para todas las plataformas (§0.3).

---

## 0. Contexto y decisiones

### 0.1 Qué es esto

PokeTokenBar lee los logs locales de uso de agentes de IA (Claude Code, Codex, Gemini, Grok,
Copilot, Cursor, Antigravity, Kiro, OpenCode, Hermes) y los convierte en un juego tipo
Pokémon: un compañero que sube de nivel con tu uso, tienda, bolsa, pokédex.

El original es un app de barra de menú de macOS: 9.622 líneas, de las cuales ~5.900 son la
lógica portable (`Core`) y ~3.740 la UI en SwiftUI/AppKit.

### 0.2 Por qué TypeScript y no compartir el Swift

Se evaluó a fondo compartir `Core` por compilación (binario Swift empaquetado en el `.vsix`).
Funciona, y era la recomendación mientras el objetivo era *"que funcione en mi Windows"*.

Lo que cambió: el objetivo pasó a **"que lo pueda usar todo el mundo"**. Y eso obliga a
soportar VS Code en Windows nativo, macOS Intel y ARM, Linux x64 y ARM → **cinco targets**,
cinco binarios Swift, y con ellos vuelve lo más caro del plan: Swift en Windows con `sqlite3`
vendorizado y enlazado estático.

TypeScript elimina eso de raíz: **un artefacto, todas las plataformas, sin toolchain**.

**El precio, que hay que tener presente todos los días:** se forkean ~5.900 líneas y se
pierde el trabajo de upstream, que se mueve a **~4,6 commits/día** (287 commits en los 2
meses de vida del repo) con **~133 en `Core`** y **un proveedor nuevo cada 2-3 semanas**
(Antigravity #141, Copilot #155, Kiro #170). Distribuir a terceros hace esto más grave, no
menos: tus usuarios pedirán los proveedores nuevos.

Por eso §8 (seguimiento de upstream) **no es opcional** — es lo que hace sostenible esta
decisión.

### 0.3 Sin binarios nativos — cómo

| Necesidad | En Swift | En TypeScript |
|---|---|---|
| Leer SQLite (Cursor, Copilot, kiro, Antigravity) | `import SQLite3` | **`sql.js` (SQLite en WASM)** — puro JS, sin módulo nativo |
| zlib (caché) | `NSData.compressed` | `node:zlib` — integrado |
| Parseo JSONL | `JSONSerialization` | `JSON.parse` sobre streams |
| Red | `URLSession` | `fetch` / `node:https` |
| Credenciales | Keychain + fichero | **solo fichero** — `OAuthLimitsProvider:157` ya lo prefiere |

**`better-sqlite3` está descartado**: es un módulo nativo y devolvería el problema de los
cinco targets. `sql.js` es más lento, pero solo se leen unos pocos ficheros `.vscdb`.

### 0.4 Arquitectura

```
  VS Code (Windows | macOS | Linux, local o Remote-WSL/SSH/container)
    └─ Extension host (Node.js)
         ├─ extension.ts        · status bar, comandos, notificaciones
         ├─ webview             · UI del juego (HTML/CSS)
         └─ worker_thread ──────· escaneo y parseo   ← NUNCA en el hilo principal
                                   lee ~/.claude, ~/.codex, …
```

**Regla de diseño no negociable:** el escaneo corre en un **`worker_thread`**. En el diseño
anterior el parseo vivía en otro proceso; aquí vive dentro del extension host, y bloquear ese
hilo congela funciones de VS Code para el usuario. El escaneo en frío del original tarda
*decenas de segundos*.

### 0.5 Dónde viven los datos (medido en la máquina de desarrollo)

| | WSL (`/home/diegomarty`) | Windows (`C:\Users\Diego`) |
|---|---|---|
| `.claude` | **970 MB** (609 `.jsonl`) | 800 KB |
| `.codex` | **494 MB** (5.729 ficheros) | 80 MB (5.379 ficheros) |
| `.copilot` | 64 KB | — |
| Cursor | — | `AppData\Roaming\Cursor` |

Sirve como banco de pruebas real: **1,4 GB y 6.300 ficheros** para medir rendimiento, no
solo fixtures.

Nota de despliegue para usuarios de WSL: con `"extensionKind": ["workspace"]` el host corre
dentro de WSL y lee a velocidad nativa (~110 ms). Si corriera en Windows leyendo `\\wsl$\`,
pagaría ~2.000 ms — medido, ~17× más lento y sin mejorar con caché caliente.

---

## Fase 1 — Andamiaje y oráculo de paridad

**Meta:** un esqueleto de extensión que arranca, y un arnés que compara TS contra Swift.
**Terminada cuando:** `npm test` corre y el oráculo puede diffear ambas implementaciones.

### 1.1 Esqueleto

- Directorio `extension/` (TypeScript, `npm`, `esbuild`).
- `package.json`: `"extensionKind": ["workspace"]`, `"activationEvents": ["onStartupFinished"]`.
- Runner de tests (`vitest` para lógica pura, `@vscode/test-electron` para integración).

### 1.2 Traer los fixtures

`Tests/PokeTokenBarTests/Fixtures/` ya existe (`CodexFork`, `CodexSubagent`). Los tests de TS
consumen **los mismos ficheros**, sin copiarlos: una sola fuente de verdad para los casos límite.

### 1.3 El oráculo *(recomendado, no obligatorio)*

La verificación más fuerte disponible: ejecutar **ambas** implementaciones sobre los mismos
datos y diffear el JSON.

1. Compilar el `Core` Swift bajo Linux (ver §A, apéndice) como binario de un disparo que
   escupe el snapshot.
2. Correr TS y Swift sobre los fixtures **y sobre los 1,4 GB reales**.
3. Diffear. Cualquier diferencia es un bug del port, no una opinión.

Los fixtures cubren casos conocidos; los 1,4 GB reales cubren los que nadie previó. Es
justamente el punto que avisa `defect-log.md`: un test puede pasar por un camino distinto al
que dispara el defecto y dar falsa confianza.

> Si el coste de levantar Swift en Linux resulta alto, se puede saltar — pero entonces la
> única red de seguridad son los tests portados, y hay que portarlos **todos**.

---

## Fase 2 — Portar el núcleo de parsing

**Meta:** leer Claude Code y Codex correctamente.
**Terminada cuando:** los totales de hoy/semana/mes cuadran con el oráculo sobre 1,4 GB reales.

Es la fase más larga y la que decide si el proyecto es correcto.

### 2.1 Método: **primero el test, luego el código**

Para cada fichero:

1. Portar su fichero de test de Swift a TS **antes** de portar la implementación.
2. Portar la implementación hasta que pase.
3. Inyectar el defecto a propósito y confirmar que el test **falla**. Un test que nunca ha
   fallado no demuestra nada — regla explícita del protocolo de defectos de `CLAUDE.md`.

**Los 34 ficheros de test valen más que el código fuente.** Codifican años-persona de casos
límite reales: forks de Codex, subagentes, deduplicación de sesiones, `null` de JSON que no
es lo mismo que la clave ausente, conteos que hay que clampar en el borde del parseo.

### 2.2 Orden y tamaño

| Fichero Swift | Líneas | Qué es |
|---|---:|---|
| `Models.swift` | 410 | tipos base — **primero, todo depende de él** |
| `ModelPricing.swift` | 68 | tabla de precios |
| `TokenFormatter.swift` | 54 | formato de números (respeta el locale del sistema) |
| `UsageEnvironment.swift` | 69 | overrides por variable de entorno |
| `LocalUsageReader.swift` | **1264** | Claude/Codex/Gemini/Grok · JSONL · forks · bloques de 5 h |
| `LocalUsageCache.swift` | 373 | caché incremental por `(path, mtime, size)` |
| `LocalUsageProvider.swift` | 171 | fachada de proveedor |

### 2.3 La caché incremental es obligatoria, no una optimización

`LocalUsageCache` documenta el motivo: si codificas a diario, casi todos los ficheros de
sesión están "modificados este mes" (cientos de MB), así que filtrar por `mtime` **no evita**
el parseo completo en cada refresco. La caché lo baja a ~0,1 s en régimen y limita el
escaneo en frío (decenas de segundos) a **una sola vez**.

Portarla con fidelidad, incluida la invalidación por `(path, mtime, size)` y el versionado de
parser que ya tiene. Formato en disco: se puede elegir uno nuevo (no hay que ser compatible
con el Swift), pero **decidirlo explícitamente**, no por descuido.

### 2.4 Trampas ya documentadas — leerlas antes de portar

- `LocalUsageReader:1242` — un `null` explícito de JSON no es lo mismo que una clave ausente.
  Comprobar `json["x"] == nil` está mal.
- `LocalUsageReader:15` — la ventana de bloque es de 5 h; el mínimo de `mtime` se deriva del
  mínimo entre inicio de mes, inicio de semana y `now - 5h`.
- Identificación de turnos de Codex **por contenido, no por posición** en el fichero (#137).
- Clampar los conteos en el borde del parseo, no más tarde (#145).
- Consultar `docs/reference/defect-log.md` **antes** de cada fichero: es el registro de
  errores ya cometidos una vez.

---

## Fase 3 — La extensión mínima usable

**Meta:** tu porcentaje de límite en la barra de estado, refrescándose solo.
**Terminada cuando:** lo estás usando a diario. **Aquí llega el 80% del valor.**

### 3.1 El worker

- `worker_thread` que hace el escaneo y devuelve el snapshot.
- Cancelar el trabajo en curso si llega otro refresco. Nunca dos escaneos a la vez.
- Timeout y recuperación: si el worker muere, la barra lo dice.

### 3.2 Planificación

- Intervalo por defecto **120 s** (el mismo que el original), configurable con los presets de
  `UsageStore.intervalPresets`.
- Refresco al activar y por comando manual.
- Back-off cuando `vscode.window.state.focused` es `false`. **No** parar del todo.
- Un solo timer para todo.

### 3.3 Status bar

- `StatusBarItem` a la derecha, prioridad estable.
- **Limitación aceptada: solo admite codicons, no imágenes propias.** No se puede poner un
  sprite de Pokémon animado a color en la barra (microsoft/vscode#72244, abierto desde 2019).
  Queda como `⚡ 82% · Charmander Lv12` — codicon o emoji más texto.
- Tooltip con `MarkdownString`: desglose por proveedor.
  *Por verificar:* si admite imágenes por data-URI, ahí sí cabría el sprite.
- Estado de error **visible** (`$(warning)` + `statusBarItem.warningBackground`). Nunca fallar
  en silencio.
- Click → abre el webview (Fase 6).

### 3.4 Ajustes

`contributes.configuration`: intervalo, idioma, límites como usado/restante, proveedores
activos, raíces extra, notificaciones on/off.

---

## Fase 4 — El resto de proveedores

**Meta:** paridad de proveedores con upstream.

| Fichero Swift | Líneas | Notas |
|---|---:|---|
| `LocalAdditionalUsageProvider.swift` | **1077** | Cursor, Copilot, kiro-cli, OpenCode, Hermes. **SQLite vía `sql.js`.** Ya comparte el escaneo incremental de Cursor y Copilot (#157) — conservar esa unificación. |
| `LocalAntigravityUsageReader.swift` | 542 | SQLite |
| `CodexRateLimitsProvider.swift` | 76 | red |
| `OAuthLimitsProvider.swift` | 271 | **sin Keychain** — solo `~/.claude/.credentials.json` |
| `ProviderStatusChecker.swift` | 116 | red |
| `UsageEnvironment` + resolución por shell | 69 + parte de `BinaryLocator` | ver 4.2 |

### 4.1 Rutas por plataforma

Aquí es donde "todo el mundo" cuesta trabajo real. Cada proveedor con ruta propia de
plataforma necesita las tres variantes:

| Herramienta | macOS | Windows | Linux |
|---|---|---|---|
| Cursor | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` | `%APPDATA%\Cursor\User\globalStorage\state.vscdb` | `~/.config/Cursor/...` |
| kiro-cli | `~/Library/Application Support/kiro-cli/` | `%APPDATA%\kiro-cli\` — **verificar en una máquina real** | `~/.local/share/kiro-cli/` |
| OpenCode | `~/.local/share/opencode/` | `%LOCALAPPDATA%\opencode\` — **verificar** | `~/.local/share/opencode/` |
| Claude Desktop | `~/Library/Application Support/Claude` | `%APPDATA%\Claude` | — |

**Las filas marcadas son suposiciones. No enviar una ruta adivinada** — confirmar contra una
instalación real. Seguir `docs/reference/provider-extension.md`: nada de ramas
`== "claude_code"` en rutas genéricas.

### 4.2 Variables de entorno y el shell de login

`UsageEnvironment` resuelve `CLAUDE_CONFIG_DIR`, `OPENCODE_DATA_DIR`, `HERMES_HOME`,
`COPILOT_HOME`, `GROK_HOME`. En el original hay que levantar un shell de login porque un
`.app` de macOS no hereda el entorno del usuario.

**En VS Code esto es más fácil:** el extension host normalmente ya hereda el entorno de la
terminal. Simplificar en vez de portar la maquinaria de `BinaryLocator`, pero dejar el
fallback de shell de login para quien arranque VS Code desde el Dock/menú de inicio.

`CLAUDE_CONFIG_DIR` acepta **rutas separadas por comas** — así un usuario con logs en WSL y
en Windows ve ambos.

---

## Fase 5 — Lógica de juego

**Meta:** el compañero sube de nivel, se pueden abrir huevos, comprar y coleccionar.

| Fichero Swift | Líneas |
|---|---:|
| `CompanionModel.swift` | 575 |
| `CompanionStore.swift` | **1184** |
| `SaveTransfer.swift` | 218 |
| `Localization.swift` | 596 (ko/en/ja/es — porte directo) |
| `PokeAPIClient.swift` | 221 |
| Umbrales y agregación de `UsageStore.swift` | ~300 de 988 (el resto es AppKit) |

### 5.1 Persistencia

Estado del juego en un JSON bajo el directorio de datos global de la extensión, **no** en
`workspaceState` (el compañero es global, no por proyecto).

`CompanionStore:66` soporta `PTB_STATE_DIR` como override — conservarlo para tests.

Versionar el fichero de guardado desde el día uno y escribirlo de forma atómica. `SaveTransfer`
existe porque perder la partida es el peor fallo posible de este app.

### 5.2 Sprites

Se bajan de PokéAPI en runtime y se cachean en disco con LRU (el original usa 64 entradas,
0,5-1 KB por PNG estático). **Nunca empaquetarlos en el repo** — obligación de licencia; ver
`LICENSE` y el disclaimer de Pokémon.

---

## Fase 6 — Webview: la UI del juego

**Meta:** paridad funcional con el popover de macOS.

Orden: **uso → compañero → tienda/bolsa/pokédex → ajustes.**

Referencia: `UI/PopoverView.swift` (641), `CompanionView.swift` (1056), `ShopView.swift` (216),
`BagView.swift` (138), `SettingsView.swift` (555).

- El webview **está cerrado casi todo el día** → aquí el criterio es velocidad de
  implementación, no eficiencia. Es lo contrario de la Fase 3.
- **No** usar `retainContextWhenHidden` (caro). Serializar y restaurar con `WebviewPanelSerializer`.
- CSP estricta; recursos locales vía `webview.asWebviewUri`.
- Variables CSS de VS Code (`--vscode-*`) para respetar el tema del usuario.
- **Parar la animación al ocultar el webview** (`onDidChangeViewState`).
  `PokeTokenBarApp.swift:250-290` documenta, *medido*, que la animación siempre activa era el
  principal culpable del CPU en reposo. No hay bandeja, pero la lección aplica igual.
- Aquí los GIF animados son un `<img>`. Sin trucos.

**No se porta `UI/FloatingPetPanel.swift` (486 líneas)** — opt-in, apagado por defecto,
ventana siempre visible con animación. No tiene equivalente sensato.

---

## Fase 7 — Publicación

- Un solo `.vsix`, sin `--target`. **Sin matriz de plataformas** — ese era el objetivo.
- Publisher, icono, README, CHANGELOG, `LICENSE` (MIT) intacta.
- Mantener el **disclaimer de Pokémon**. Sprites siempre en runtime desde PokéAPI.
- Atribución a `chattymin/PokeTokenBar` como obra original — es MIT y es lo correcto.
- Reporte de errores sin telemetría: un comando "copiar diagnóstico" que vuelca versiones,
  proveedores detectados y últimos errores.

---

## 8. Seguimiento de upstream — **el mecanismo que sostiene todo esto**

Al reescribir en TS se pierde el trabajo de upstream automáticamente. Esto es lo que evita
quedarse atrás, y por §4 del protocolo de defectos de `CLAUDE.md` tiene que ser **mecanismo,
no memoria**:

1. El remote `upstream` y el árbol Swift **se conservan**. No se borra `Sources/`.
2. Un fichero `PORTED-THROUGH` en la raíz con el SHA de upstream ya incorporado.
3. Rutina periódica:
   ```
   git fetch upstream
   git log --oneline <PORTED-THROUGH>..upstream/main -- Sources/PokeTokenBar/Core/
   ```
   Cada commit que salga: portarlo a TS o anotar por qué no aplica. Actualizar el SHA.
4. Los proveedores nuevos llegan por aquí. **Es la vía, no una tarea de mantenimiento aparte.**

El árbol Swift **no se compila** — no hay job de CI de macOS. Está ahí para poder diffear.

---

## Verificación

| Fase | Cómo se comprueba |
|---|---|
| 1 | El oráculo corre y diffea ambas implementaciones |
| 2 | Totales cuadran con el oráculo sobre **1,4 GB reales**, no solo fixtures |
| 3 | La barra se refresca sola. Matar el worker debe producir error **visible**. Medir que el escaneo **no bloquea** la UI de VS Code. |
| 4 | Cada proveedor cuadra con el oráculo. Rutas de Windows/Linux verificadas en instalación real. |
| 5 | Partida sobrevive a reiniciar VS Code. Simular escritura interrumpida y comprobar que no se corrompe. |
| 6 | Paridad pantalla a pantalla. La animación para al ocultar el webview. |
| 7 | Instalar el `.vsix` en limpio, en las tres plataformas |

**CI:** `npm run compile` + `vitest` + `@vscode/test-electron`. Sin job de macOS — ya no se
compila Swift.

**Rendimiento, con presupuesto explícito:** escaneo en régimen ≲300 ms sobre los 1,4 GB
reales; escaneo en frío tolerable en un worker. Si se sale del presupuesto, la caché
incremental está mal portada.

---

## Riesgos conocidos

- **Regresión de corrección en los parsers. Es *el* riesgo.** ~5.900 líneas reescritas con
  casos límite ganados a pulso. Mitigación: tests primero (§2.1) + oráculo sobre datos reales
  (§1.3). Sin al menos uno de los dos, esto es una apuesta.
- **Deriva de upstream.** ~4,6 commits/día, un proveedor nuevo cada 2-3 semanas. Sin §8
  ejecutado de verdad, la extensión queda obsoleta en meses.
- **Rendimiento en Node.** 609 ficheros JSONL / 868 MB solo de Claude. Medir pronto, no al
  final. Si el parseo en TS resulta inviable, el diseño anterior (binario Swift) sigue ahí
  como salida — pero eso reintroduce los cinco targets.
- **Bloqueo del extension host.** No existía cuando el parseo vivía en otro proceso. El
  `worker_thread` no es opcional.
- **`sql.js` es más lento que SQLite nativo.** Se leen pocos ficheros, debería bastar. Medir
  con la base de Cursor real antes de darlo por bueno.
- **Sin sprite animado en la barra.** Limitación de VS Code, no arreglable.
- **Solo vive con VS Code abierto.** Limitación estructural.
- **Exposición de IP al distribuir.** Temática Pokémon bajo un publisher propio. Los sprites
  en runtime están bien resueltos; el nombre y la temática son de Nintendo. Upstream ya
  distribuye públicamente, así que hay precedente, pero la decisión es del publisher.

---

## Apéndice A — Levantar el oráculo Swift *(solo si se hace §1.3)*

Entorno de desarrollo verificado: Ubuntu 20.04.6 LTS x86_64.

| Hecho | Valor |
|---|---|
| Última Swift disponible para 20.04 | **6.1.2** (6.2+ da 404 para `ubuntu2004`) |
| Suficiente | Sí — `Package.swift` pide `swift-tools-version: 6.0` |
| `sudo` | pide contraseña → el `apt-get` lo lanza el usuario |
| Libs presentes | `libcurl4`, `libxml2`, `libncurses6`, `libsqlite3-0`, `libedit2`, `libgcc-s1`, `binutils` |
| Lib ausente | **`libz3-4`** |

```
! sudo apt-get update && sudo apt-get install -y \
    binutils git gnupg2 libc6-dev libcurl4 libedit2 libgcc-9-dev \
    libpython2.7 libsqlite3-0 libstdc++-9-dev libxml2 libz3-dev \
    pkg-config tzdata uuid-dev zlib1g-dev
```

Toolchain: `https://download.swift.org/swift-6.1.2-release/ubuntu2004/swift-6.1.2-RELEASE/swift-6.1.2-RELEASE-ubuntu20.04.tar.gz`
(verificado HTTP 200).

Bloqueos que hay que resolver para que `Core` compile fuera de Darwin:

| # | Bloqueo | Sitio |
|---|---|---|
| 1 | `NSData.compressed/decompressed(using:.zlib)` | `LocalUsageCache:318,367` + 12 sitios en tests |
| 2 | `import SQLite3` | `LocalAdditionalUsageProvider`, `LocalAntigravityUsageReader` + 6 tests |
| 3 | `AppEnv.isBundledApp` | `AppEnv.swift` + 8 call sites (`AppLog:33`, `UsageStore:816,879,965`, `CompanionStore:51,793,873`) |
| 4 | `Bundle.main.infoDictionary` | `CodexRateLimitsProvider:45` |
| 5 | `URLSession` | `PokeAPIClient`, `OAuthLimitsProvider`, `ProviderStatusChecker`, `UpdateChecker` → `#if canImport(FoundationNetworking)` |
| 6 | `import Security` | `OAuthLimitsProvider:2` → `#if canImport(Security)` |

**No** son bloqueo: `@Observable`, `NSLock`, `NSNumber`, `NSString.expandingTildeInPath`,
`Process`, `DispatchQueue`. No hay `arc4random`.

> Para el oráculo basta con que compile y escupa JSON. No hace falta que los tests de Swift
> pasen en Linux ni hacer el split del paquete.
