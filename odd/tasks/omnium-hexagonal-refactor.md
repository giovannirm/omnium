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
- [ ] **R2 — Partir `execute.ts`** (facade: `execute.ts` re-exporta)
  - [ ] `src/core/prepare.ts`: `prepareRequest`, `applyAuth`, `toCurl`, `PreparedRequest`, utils de URL/header
  - [ ] `src/core/http.ts`: `readLimitedBody`, `collectHeaders`, `parseJson`, `isBinary`, `decodeText`, `MAX_BODY_BYTES`, paso de envío con `HttpSender`
  - [ ] `src/core/scriptBridge.ts`: `ScriptState`, `absorb`, `renumberTests`, `scriptEffects`, `toScriptRequest`/`applyScriptRequest`/`mergeHeaders`, `toScriptResponse`
  - [ ] `execute.ts` queda como orquestador (`executeRequest` + `emptyResult` + errores/timing)
- [ ] **R3 — Partir `useAppState.ts`** (mismo contrato `AppState` vía facade)
  - [ ] Leer archivo completo y fijar seam por secciones ya marcadas (workspace/selección/ejecución/carga/chrome)
  - [ ] Sub-hooks o módulos puros; `useAppState` compone y conserva la forma de `AppState`
  - [ ] Tests de `model.ts`/estado existentes siguen verdes
- [ ] **R4 — Ordenar hosts: CLI y disk salen de `core`**
  - [ ] `src/core/cli.ts` + `src/core/disk.ts` → `src/host/`
  - [ ] Actualizar glob `test` en package.json (`src/host/*.test.ts`) y mover `cli.test.ts`
  - [ ] Corregir importadores (`src/cli.ts` entry, `engine.test.ts`)
  - [ ] Presentación (`print`/`toJson`/`message`) en `src/host/cliFormat.ts` si queda limpio
- [ ] **Cierre**: smokes (CLI e2e + HTTP `__omnium/execute`), greps de capa, docs (Progreso + tabla de slices)

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
- [ ] R1 → R4 → cierre
