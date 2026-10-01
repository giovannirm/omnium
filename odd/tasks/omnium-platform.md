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
- `npm run check` (tsc) y `npm test` (19 tests) deben seguir en verde en cada tarea.
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
- [ ] **A4** Capa de estado `src/ui/state/*` (store propio con `useSyncExternalStore`):
       workspace+autosave, selección/pestañas, resultados, load, toast/modal.
       `App.tsx` queda como composición. Ruta: inline. Verificación: check + test +
       smoke manual de la UI.
- [ ] **A5** Tests de A1/A2 y cierre de Fase A. Ruta: inline.

### Fase B — Capacidades de plataforma

- [ ] **B1** CLI/headless: `omnium run <workspace|colección>` con informe y exit code.
- [ ] **B2** Secretos en entornos: marca `secret` en `Pair`, masking en UI/export/history.
- [ ] **B3** Scripting pre/post request (alcance a definir con el usuario antes de arrancar).

## Progreso

- 2026-10-01: feature creada; exploración y diagnóstico completados; baseline verde
  (`tsc` limpio, 19/19 tests). Alcance decidido: "Ambas, por capas".
- Próximo paso: decisión del usuario sobre chain strategy (forecast > 400 líneas) → A1.
