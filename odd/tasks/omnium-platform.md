# Feature: omnium-platform

## Objetivo

Convertir lo que existe hoy (cliente de API + pruebas + carga, Electron/React/Vite) en una
**plataforma** con la mejor arquitectura: un motor único con puerto/adaptador, capa de estado
en la UI, modo standalone, y después las capacidades de producto que le faltan.

## Problema / Por qué

- El motor está duplicado en dos hosts: `vite.config.ts` (middleware `__omnium/*`) y
  `electron/main.ts` (IPC) repiten execute/run/load/cookies/abort (~100 líneas cada uno).
  Cada cambio se hace dos veces y se desincroniza.
- `src/ui/App.tsx` es un dios de 1039 líneas con ~25 `useState` y toda la orquestación.
- El modo web solo existe en dev: `webClient` llama a `/__omnium/*`, que solo sirve el
  middleware de Vite. El build `dist/` no corre fuera de Electron ni del dev server.
- No hay CLI/headless, ni secretos en entornos, ni scripting.

## Alcance (decidido con el usuario)

**Ambas, por capas**: primero la base de arquitectura (Fase A), luego las capacidades de
plataforma (Fase B). El usuario eligió esta opción explícitamente.

### En alcance
- Fase A: motor único, adaptadores delgados (Electron + HTTP), servidor standalone, capa de estado en UI.
- Fase B: CLI/headless, secretos en entornos, scripting de peticiones.

### Fuera de alcance
- Colaboración en tiempo real, sincronización en la nube, autenticación de usuarios.
- Reescritura de frameworks (se mantiene React 19 + Vite + Electron, sin nuevas dependencias de estado).
- Cambios de branding/visual más allá de lo que exijan las refactorizaciones.

## Restricciones

- Sin nuevas dependencias runtime (solo react/react-dom); el store de estado es propio.
- `npm run check` (tsc) y `npm test` deben seguir en verde en cada tarea (52 tests tras B1).
- Código y artefactos técnicos en español solo donde el proyecto ya lo usa (strings, tests);
  identificadores en inglés.
- Commits convencionales, sin atribución a IA.
- Ruta elegida por tarea: `inline` o `delegado`. **Delegación bloqueada en esta sesión**
  (el proveedor rechazó los subagentes: "free tier can only be used from within OpenCode"),
  así que todas las tareas corren `inline` y queda registrado aquí para que sea observable.

## Estrategia de entrega

- `delivery_strategy`: `ask-on-risk` (default). Forecast > 400 líneas → chain strategy pedida.
- `chain_strategy`: **`stacked-to-main`** (elegido por el usuario).
- Rama: `feat/engine-runtime` (creada antes del primer commit; base `master`).
- Un commit = una unidad de trabajo = un PR candidato. Cada slice ≤400 líneas autoradas:

| Slice | Commits | Líneas autoradas |
| --- | --- | --- |
| PR 1 | `6de6c2e` chore (tooling + plan) | ~97 |
| PR 2 | `854bc88` feat(engine): EngineRuntime | 182 |
| PR 3 | `8e0db9a` refactor(server): router compartido | 395 |
| PR 4 | `ac804b3` feat(server): standalone `npm run serve` | 150 |
| PR 5 | `d828a8f` refactor(electron): IPC delgado | 85 |
| PR 6 | `0958373` refactor(ui): modelo puro extraído | 724 — **size:exception** (una sola unidad coherente, migración de `Sidebar.tsx` incluida) |
| PR 7 | `eec4a12` refactor(ui): workspace + acciones de entidades | 539 — **size:exception** (unidad coherente de migración) |
| PR 8 | `92a01c7` refactor(ui): ejecución y carga en la capa de estado | 327 |
| PR 9 | `0e42990` refactor(ui): chrome de la interfaz en la capa de estado | 346 |
| PR 10 | `b5b2593` test(server): standalone end to end | 84 |
| PR 11 | `487b2c6` feat(cli): run headless con informe | 364 |
| PR 12 | `f927a0c` feat(secrets): marca secret + masking en exportación | 144 |
| PR 13 | `f09fba9` feat(script): runner de scripts pre/post | 349 |
| PR 14 | `2077375` feat(model): pre/post en petición, colección y ambiente | 58 |
| PR 15 | `3204a30` feat(engine): orquestación de scripts + loader de módulos | 455 — **size:exception** (unidad coherente: motor + runner + hosts; cortarla dejaría el motor a medio cablear) |
| PR 16 | `15bae2c` feat(ui): editor de scripts, logs y cambios de ambiente | 307 |
| docs | `0fd0d9e`, `a6fb563`, `be6b4bd` + este commit: plan/avance | — |

## Criterios de aceptación

1. El motor se implementa UNA vez; Electron y el HTTP server son adaptadores delgados.
2. `dist/` sirve la app con `npm run serve` sin Electron (modo standalone funcional).
3. `App.tsx` queda como composición: sin lógica de negocio ni autosave inline.
4. `npm run check` y `npm test` en verde; tests nuevos para runtime y router.
5. Capacidades Fase B entregadas con tests.

## Checklist de tareas

### Fase A — Base de arquitectura

- [x] **A1** `src/core/engine.ts` — `EngineRuntime`: dueño único de CookieJar + aborts de
       HTTP y carga; expone `execute`, `run`, `startLoad`, `stopLoad`, `listCookies`,
       `clearCookies`, `cancel`. Elimina `src/core/session.ts` (singleton global).
       Ruta: inline (delegación bloqueada). ✅ check + 3 tests nuevos (cookies compartidas,
       cancelHttp, stopLoad).
- [x] **A2** `src/server/router.ts` + `src/server/serve.ts` — router HTTP compartido
       `__omnium/*` sobre un `EngineRuntime` inyectado + servidor estático para `dist/`.
       `vite.config.ts` delega en el router (deja de duplicar la lógica).
       Script `npm run serve`. Ruta: inline. ✅ 4 tests de router + smoke manual:
       index 200, assets 200, motor responde, anti-traversal (dot-segments y %2f caen
       en index.html), fallback SPA 200.
- [x] **A3** `electron/main.ts` pasa a adaptador delgado sobre `EngineRuntime`
       (handlers IPC de una línea). Ruta: inline. ✅ check + `build:electron` + 26 tests.
- [x] **A4** Capa de estado `src/ui/state/*` (hook `useAppState` + modelo puro):
        - [x] A4-1 `model.ts` (295 líneas, lógica pura) + 11 tests → `Sidebar.tsx` re-exporta
          `Selection`. Commit `0958373`.
        - [x] A4-2 dominio workspace: load/autosave/beforeunload/prune, `adopt`, `openArea`,
          `createArea`, `exportArea`, selección/pestañas, toast, cookies y todas las
          mutaciones de colecciones/peticiones/ambientes. Commit `eec4a12`.
        - [x] A4-3 dominio ejecución: `results`, `report`, `runtime`, `pending`, `pane`,
          `load`, `plan`, `send`, `testCollection`, `startLoad`, `remember` + efecto de
          `onLoadTick`/`onLoadDone`. Commit `92a01c7`.
        - [x] A4-4 chrome: modal, layout/resize, query, atajos, menú, `importArea`,
          `beginImport`, `commands` → `App.tsx` es composición + JSX (510 líneas, sin
          `useState` propio salvo los diálogos). Commit `0e42990`.
        Ruta: inline (delegación bloqueada). ✅ check + 37 tests + `build:renderer` verdes.
        ⚠️ **Smoke manual de la UI con navegador pendiente** (no ejecutado: no hay navegador
        automatizado en la sesión).
- [x] **A5** Tests de A1/A2 y cierre de Fase A: `src/server/serve.test.ts` (7 tests: index,
       assets, fallback SPA, intentos de fuga `..` y `%2e`, motor por HTTP, 503 sin build,
       405) + smoke manual de `npm run serve` (index 200, motor 200, rutas SPA 200).
       Ruta: inline. ✅ check + 44 tests + build verdes. Commit `b5b2593`.

### Fase B — Capacidades de plataforma

- [x] **B1** CLI/headless: `npm run omnium -- run <workspace|colección.json>` con
       `--collection`, `--env`, `--json`; informe texto/JSON; códigos 0/1/2.
       `src/core/cli.ts` (lógica + `runCli` testeable), `src/cli.ts` (entrada delgada),
       reutiliza `EngineRuntime`, `loadFromDir`/`saveToDir`, `importPostman`,
       `parseWorkspace`. Ruta: inline. ✅ check + 8 tests nuevos en
       `src/core/cli.test.ts` (52 totales) + build verdes. Commit `487b2c6`.

- [x] **B2** Secretos en entornos: `Pair.secret` (marca explícita + toggle en `PairTable`,
       campo enmascarado), `src/core/secrets.ts` (`maskWorkspace`, `maskPairs`,
       `hasSecrets`, `secretKeys`); el área en disco conserva los valores reales y
       **la exportación JSON los enmascara**; los snippets avisan cuando el código
       embebe un secreto. El historial no guarda valores de variables (verificado en
       `HistoryEntry`), así que no hay filtración ahí. Ruta: inline. ✅ check + 4 tests
       nuevos (`src/core/secrets.test.ts`, 56 totales) + builds verdes.
       Commit `f927a0c`.
- [x] **B3** Scripting pre/post request — **alcance amplio (elegido por el usuario)**:
      scripts a nivel petición, colección y ambiente; módulos npm locales; editor con
      resaltado. Contrato decidido:
      - Fases `pre`/`post` en `RequestModel`, `Collection` y `Environment`.
      - Los scripts corren en el host del motor (siempre Node: middleware de Vite,
        servidor standalone, main de Electron, CLI) con `new Function` envuelto en
        async — **sin `node:vm`** porque `execute.ts` se empaqueta también en el renderer.
      - API global `omnium`: `log`, `variables.get/set`, `env.get/set`, `test(name, fn)`,
        `expect(...)` propio (sin dependencias), `request` (pre), `response` (post),
        `require(spec)` solo con loader inyectado por el host.
      - Cada `omnium.test` se vuelve un `AssertionResult` (`id: script:…`) → `stepPassed`
        y el `Outcome` existente lo muestran sin tocar el motor de aserciones.
      - `ExecutePayload`/`RunPayload` ganan `pre?: ScriptHook[]` (`{label, code}`),
        `post?: ScriptHook[]`, `environment?: Pair[]`, `moduleDir?: string|null` y
        `requireModule` (lo adjunta el host en proceso; JSON lo descarta); los cambios
        de `env.set` vuelven como `environmentChanged`.
      - Tareas:
        - [x] **B3-1** `src/core/script.ts` + tests: `runScript`, API, expect, deadline.
               Orden de `tests` = orden de llamada (reserva de slot + `Promise.all`).
               Ruta: inline. ✅ 10 tests nuevos. Commit `f09fba9`.
        - [x] **B3-2** tipos/persistencia: `preScript`/`postScript` en petición,
               colección y ambiente (`types`, `factory`, `files.ts` + tests de vuelta;
               ojo: `filesToWorkspace` arma colecciones en línea, no usa `asCollection`).
               Ruta: inline. ✅ 2 tests nuevos → 68. Commit `2077375`.
        - [x] **B3-3** motor: hooks en payloads, orquestación en `executeRequest`
               (pre: ambiente → colección → petición; post: petición → colección →
               ambiente; un pre que falla aborta antes de la red, un post que falla
               queda como aserción fallida), `environmentChanged` en resultado e
               informe, merge de `extracted` sin gate de `ok`, loader de módulos en
               router/Electron/CLI, CLI compone hooks + imprime logs. Ruta: inline.
               ✅ 4 tests de integración → 72 + builds. Commit `3204a30` (455 líneas,
               size:exception: unidad motor+hosts).
        - [x] **B3-4** UI: `ScriptEditor` (textarea transparente sobre `pre`
               tokenizado — comentarios/cadenas/números/palabras clave/`omnium`,
               sin dependencias) en pestaña Scripts de la petición, en el editor
               de ambiente y en la etapa de colección; logs de scripts en el
               panel Pruebas; `applyEnvironmentChanges` en `model.ts` + los
               payloads de `send`/`testCollection` llevan hooks, ambiente y
               `moduleDir`. Ruta: inline. ✅ 2 tests nuevos → 74 + builds.
               Commit `15bae2c`.
        - [x] **B3-5** módulos locales: `src/host/moduleLoader.ts` (createRequire
               desde el dir del área) enganchado en router (usa `moduleDir` del
               payload), Electron (`currentDir` de respaldo) y CLI; sin loader el
               error ya vive en `script.ts`. Verificado con smoke real: módulo
               local cargado desde la CLI y mensaje claro sin loader.
        - [x] **B3-6** cierre: ✅ `check` limpio, **74/74 tests**, builds de
               renderer y Electron verdes; smokes: CLI end-to-end (hooks, logs,
               `ultimo=token-ada` propagado por la corrida, `omnium.require`),
               y por HTTP (`POST /__omnium/execute` con pre/post → `script:1`
               pasó, `environmentChanged: {via: "http"}`).

## Progreso

> ⚠️ **Espejo Engram pendiente**: `mem_save` del topic `odd/omnium-platform/tasks` falla en
> esta sesión (el servidor Engram no confirma el registro de la sesión, 3 intentos). El
> archivo local es la fuente de verdad hasta que se pueda re-sincronizar.

- 2026-10-01: feature creada; exploración y diagnóstico completados; baseline verde
  (`tsc` limpio, 19/19 tests). Alcance decidido: "Ambas, por capas".
- 2026-10-02: A1–A3 verdes (motor único, router+serve, IPC delgado). A4 completo
  (`0958373`, `eec4a12`, `92a01c7`, `0e42990`): `App.tsx` 1039 → 510 líneas, solo
  composición + diálogos presentacionales; `useAppState.ts` 605, `model.ts` 295.
  A5 completo (`b5b2593`): 44 tests, smoke de `npm run serve`.
- **Fase A cerrada**. Pendiente único: smoke visual de la UI en navegador.
- 2026-10-02: **B1 completo** (`487b2c6`): CLI headless `npm run omnium -- run …`,
  8 tests nuevos → 52 en verde; smoke de `help` y código de salida 2 verificado.
- 2026-10-02: **B2 completo** (`f927a0c`): 4 tests nuevos → 56 en verde. El historial
  no almacena valores (comprobado en `HistoryEntry`), por eso el masking se aplica a
  la exportación y a la UI, no a `history.json`.
- 2026-10-02: **B3 en marcha — alcance "Amplio" elegido por el usuario**.
  B3-1 (`f09fba9`), B3-2 (`2077375`), B3-3 (`3204a30`) completos: scripts
  pre/post persisten, se orquestan en el motor (ambiente → colección → petición
  en pre; inverso en post), los tests de scripts entran como `script:n` en las
  aserciones, `omnium.env.*` reporta `environmentChanged` y los hosts con Node
  adjuntan el loader de `omnium.require`. 72 tests en verde, builds verdes.
  Siguiente: B3-4 (editor UI + logs en Outcome + aplicar cambios de ambiente).
- 2026-10-02: **B3 completo — Fase B completa** (alcance "Amplio").
  B3-1 `f09fba9`, B3-2 `2077375`, B3-3 `3204a30`, B3-4 `15bae2c`, B3-5/B3-6
  verificados en el cierre: 74 tests verdes, builds verdes, smokes de CLI
  (hooks + `omnium.require` con módulo local + `environmentChanged` propagado)
  y de HTTP (`/__omnium/execute` con scripts). Orden de hooks: ambiente →
  colección → petición en pre; inverso en post. Un pre que falla aborta antes
  de la red; un post que falla queda como aserción fallida (`script:n`).
- **Pendientes**: smoke visual de la UI en navegador (editor de scripts sin
  revisar en vivo), espejo Engram del plan (`mem_save` falla en esta sesión),
  y la entrega en PR (rama `feat/engine-runtime`, 24 commits sin push;
  push/PR son decisión del usuario).
