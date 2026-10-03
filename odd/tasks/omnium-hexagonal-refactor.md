# Feature: refactor hexagonal quirúrgico (Omnium)

- **Feature**: `omnium-hexagonal-refactor`
- **Rama**: `refactor/hexagonal-ports` (base: `feat/engine-runtime`)
- **Fecha**: 2026-10-02
- **Ruta elegida**: direct inline (subagentes bloqueados por OpenCode free tier — decisión documentada).
- **Estrategia de entrega**: `ask-on-risk` con chain strategy **`stacked-to-main`** (ya establecida en este proyecto: cada PR mergea a main en orden; PR candidato = commit unidad de trabajo).
- **Modo TDD**: deshabilitado (no hay runner configurado para TDD estricto); se corren `npm run check` + `npm test` en cada tarea.

## Objetivo

Mejorar la arquitectura sin reescrituras: hacer explícitos los puertos de salida que hoy
están implícitos, partir los dos archivos "dios" y eliminar la única arista invertida
(`core` → `host`), manteniendo el grafo de dependencias actual (que ya apunta bien).

## Por qué (diagnóstico con evidencia)

- `src/core/execute.ts` = 633 líneas con 6 responsabilidades (prep, fetch, parseo,
  orquestación de scripts, curl, utils).
- `src/ui/state/useAppState.ts` = 631 líneas: workspace + ejecución + chrome en un hook.
- `fetch` global hard-codeado en `execute.ts:105`: puerto de salida implícito, no falsificable
  sin mock global.
- `src/core/cli.ts` importa `src/host/moduleLoader.ts` (arista invertida) y trae `node:fs`
  + presentación (`print`/`toJson`) dentro de `core`.

## Alcance

- **Sí**: puertos explícitos en `core`, split de `execute.ts`, split de `useAppState`,
  mover CLI/disk de `core` a `host`, re-exports facade para no romper importadores.
- **No**: renombrar directorios a `domain/application/adapters` (churn con valor nulo),
  cambios de comportamiento, cambios de UI salvo imports, nuevas dependencias.

## Criterios de aceptación

1. `npm run check` y `npm test` verdes en cada commit (74 tests como base + nuevos).
2. Sin cambio de comportamiento: los smokes CLI/HTTP de B3 siguen iguales.
3. Greps de capa limpios al cierre: `core` sin `node:fs`, sin imports a `../host`
   desde `core`, sin `fetch(` fuera del adaptador.
4. `execute.ts` y `useAppState.ts` por debajo de ~300 líneas cada uno.
5. Un commit = unidad de trabajo = PR candidato; tamaño registrado abajo.

## Tareas

- [x] **R1 — Puerto `HttpSender` explícito** (inline)
  - [x] `src/core/ports.ts` con `HttpSender = (url, init) => Promise<Response>`
  - [x] `executeRequest` acepta `send?: HttpSender` (default: `fetch` global)
  - [x] Nuevo `src/core/execute.test.ts` con fake sender: pre que falla → sender jamás
        llamado (aborta antes de la red); sender recibe url/init preparados; post que
        falla → respuesta intacta + aserción fallida (3 tests nuevos → 77)
- [x] **R2 — Partir `execute.ts`** (facade: `execute.ts` re-exporta) — commit `3898a14`+siguiente
  - [x] `src/core/prepare.ts`: `prepareRequest`, `applyAuth`, `toCurl`, `PreparedRequest`, utils de URL/header (186 líneas)
  - [x] `src/core/http.ts`: `readLimitedBody`, `collectHeaders`, `parseJson`, `isBinary`, `decodeText`, `MAX_BODY_BYTES`, `sendPrepared` con `HttpSender` (117 líneas)
  - [x] `src/core/scriptBridge.ts`: `ScriptBinding`, `ScriptState`, `absorb`, `renumberTests`, `scriptEffects`, `toScriptRequest`/`applyScriptRequest`/`mergeHeaders`, `toScriptResponse` (115 líneas)
  - [x] `execute.ts` queda como orquestador (`executeRequest` + `emptyResult` + errores/timing): **278 líneas**
- [x] **R3 — Partir `useAppState.ts`** (facade: mismo contrato `AppState`)
  - [x] Leer archivo completo y fijar seam por secciones ya marcadas (workspace/selección/ejecución/carga/chrome)
  - [x] Módulos puros `create*Actions(deps)` llamados dentro del hook (mismas closures por render):
        `workspaceActions.ts` (231: persistencia, selección/pestañas, entidades, import),
        `executionActions.ts` (149: send/testCollection/startLoad, `Pane`/`LoadState`/`SessionReport`/`DEFAULT_PLAN`),
        `chromeActions.ts` (77: paleta de comandos, `startResize`, `Modal`)
  - [x] `useAppState` queda en **345 líneas** (estado + 6 efectos + derivaciones + composición;
        re-exporta `Modal`/`Pane`/`LoadState`/`SessionReport`; `AppState = ReturnType` intacto
        y `App.tsx` sin cambios) — leve desvío del objetivo ~300: los efectos permanecen en
        el hook por ser material declarativo
  - [x] Verificado: `npm run check` limpio, `npm test` 77/77, `npm run build` verde
- [x] **R4 — Ordenar hosts: CLI y disk salen de `core`**
  - [x] `git mv`: `src/core/cli.ts` → `src/host/cli.ts` (244 → **170 líneas**),
        `src/core/disk.ts` → `src/host/disk.ts`, `src/core/cli.test.ts` → `src/host/cli.test.ts`
  - [x] Presentación extraída a `src/host/cliFormat.ts` (77 líneas: `CliIo`, `print`, `toJson`,
        `mergeChanged`, `message`); `cli.ts` re-exporta `CliIo`
  - [x] **Arista invertida eliminada**: `host/cli.ts` importa `./moduleLoader.ts` (era `../host/`)
  - [x] Importadores corregidos: `src/cli.ts`, `src/core/engine.test.ts` (`../host/disk.ts`),
        `src/host/cli.test.ts` (`../core/sample|types`), **`electron/main.ts`** (no estaba en la lista)
  - [x] Glob `test` en package.json: `+ src/host/*.test.ts`
  - [x] Verificado: `npm run check` limpio, `npm test` 77/77, `npm run build` verde
- [x] **Cierre**
  - [x] Smoke CLI real: `--help` exit 0 · comando desconocido exit 2 · `run /no/existe` exit 2
  - [x] Smoke HTTP real: `npm run serve` + `POST /__omnium/execute` → `ok:true`, status 200,
        aserción pasada (12 ms)
  - [x] Greps de capa (no-test): `node:fs|path|os` en `core` **limpio**; `core → host` **limpio**;
        `fetch(` fuera de `http.ts`: solo `execute.ts:37` (binding por defecto del puerto
        `HttpSender`) y `snippets.ts:11` (string de código generado, no una llamada) — ambos esperados
  - [x] Nota: el único `core → host` restante es `engine.test.ts` → `../host/disk.ts` (fixtures de
        test; los greps de capa excluyen `*.test.ts`)
  - [x] Docs actualizadas (esta sección + Progreso)

## Forecast de líneas autoradas (al crear)

| Tarea | Estimación | PR |
|---|---|---|
| R1 | ~150 | PR17 |
| R2 | ~1300 (mayoría movimiento detectable como rename) | PR18 |
| R3 | ~500 | PR19 |
| R4 | ~400 | PR20 |
| **Total** | **~2350 → supera 400** | chain `stacked-to-main` ya cacheada |

## Progreso

- [x] Exploración y diagnóstico (evidencia de capas y tamaños)
- [x] Documento creado (esta rama, antes de la primera escritura de código)
- [x] R1 ✅ `3898a14` · R2 ✅ `c8e70a0` · R3 ✅ `367cf22` · R4 ✅ (commit de este slice) · cierre ✅

**Estado final**: refactor completo. `execute.ts` 633→278, `useAppState.ts` 631→345,
`cli.ts` fuera de `core` (arista invertida eliminada), greps de capa limpios,
77/77 tests + `tsc` + build verdes. Pendiente del usuario: push y creación de
PR17–PR20 (stacked-to-main); smoke visual de la UI en navegador.
