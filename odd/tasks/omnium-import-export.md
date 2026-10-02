# Feature: interchange completo (import/export multi-formato)

- **Feature**: `omnium-import-export`
- **Rama**: `refactor/hexagonal-ports` (continúa sobre el refactor R1–R4; si el usuario
  prefiere partir de `master`, mover antes de la primera escritura)
- **Fecha**: 2026-10-02
- **Ruta elegida**: direct inline (subagentes bloqueados por OpenCode free tier — decisión documentada).
- **Estrategia de entrega**: `ask-on-risk` + chain **`stacked-to-main`** (ya cacheadas en sesión);
  slices = commits = PR candidatos (PR21…).
- **Modo TDD**: deshabilitado; `npm run check` + `npm test` + `npm run build` en cada slice.

## Objetivo

Que Omnium intercambie colecciones con el ecosistema real: importar de **Postman, Insomnia,
Bruno, JMeter, Hoppscotch y Thunder Client** con auto-detección, y exportar a **Postman,
Insomnia y Bruno**. Cerrar el hueco actual: el importador de Postman descarta scripts
(events), afirmaciones, params y auth heredada; `exportPostman` existe pero nadie lo usa.

**Alcance aprobado por el usuario**: "Completo" — 6 importadores con auto-detección +
diálogo de import en UI + export a Postman/Insomnia/Bruno.

## Por qué (diagnóstico con evidencia)

- Solo existe `src/core/postman.ts` (207 líneas): import v2.1 + export v2.1 sin cablear a UI.
- El import de Postman **pierde**: `events` (prerequest/test scripts), query params con
  disabled, auth de carpeta/colección, descripciones de carpeta.
- UI: solo "Importar colección Postman" (`beginImport("postman")`) + import de área.
- CLI `loadTarget`: detecta workspace o JSON con `collections`; Postman por fallback, nada más.
- Cero cobertura: Insomnia, Bruno, JMeter, Hoppscotch, Thunder Client.
- Scripts de Postman usan la API `pm.*`; nuestro motor expone `omnium.*` (`core/script.ts`).
  Sin puente, cualquier script importado revienta.

## Decisiones de diseño

1. **Puente `pm` en el motor** (`src/core/script.ts`): inyectar un alias compatible con el
   subconjunto real de Postman (`pm.test`, `pm.expect` chai-subset, `pm.environment`,
   `pm.variables`, `pm.response` incl. `to.have.status`, `pm.request`, `postman` legacy).
   Una sola fuente en runtime > generar código en cada importador; beneficia también a
   colecciones escritas a mano contra la API de Postman.
2. **Sin dependencias runtime nuevas** (filosofía del proyecto): YAML mínimo para Insomnia v5
   (subconjunto que genera Insomnia: block maps/seqs, escalares, `|`/`>`), XML dirigido para
   JMX (atributos de `HTTPSamplerProxy` vía parser de tags, no DOM completo), `.bru` parser
   propio. Si un formato excede el subconjunto seguro → fallback: se documenta el límite.
3. **Detección por contenido + extensión**: `detectFormat(text, fileName)` devuelve
   `postman | insomnia | bruno | jmeter | hoppscotch | thunder | omnium-area-desconocido`.
4. **Contrato único de importadores**: `(raw) => Collection` (ya usado por `importPostman`);
   el dispatcher no conoce formatos internos. Avisos no-fatales viajan en el resultado
   (`warnings: string[]`) para el diálogo de UI.
5. **JMX**: ThreadGroup → colección; samplers → peticiones; ResponseAssertion → aserciones
   nativas; CSVDataSet → variables de colección. El plan de carga (hilos/duración) **no** se
   mapea: `Collection` no tiene campo de plan (fuera de alcance, anotado como no-objetivo).

## Alcance

- **Sí**: 6 importadores + auto-detección + puente `pm` + diálogo de import en UI +
  export de colección a Postman/Insomnia/Bruno + `loadTarget` de CLI con auto-detección.
- **No**: export a JMeter/Hoppscotch/Thunder; mapeo de plan de carga JMX; renombrar directorios;
  nuevas dependencias; cambio de comportamiento fuera de import/export.

## Criterios de aceptación

1. `npm run check`, `npm test`, `npm run build` verdes en cada slice.
2. Cada formato con test unitario sobre fixture realista (mínimo: auth, headers, body,
   scripts/events donde aplique, carpeta/nivel anidado).
3. Auto-detección cubre los 6 formatos + workspace Omnium; desconocido → error claro en español.
4. UI: un solo comando "Importar colección…" con selección de formato (auto por defecto) y
   avisos visibles; export de colección a los 3 formatos.
5. CLI: `npm run omnium -- run archivo.<cualquiera>` resuelve vía dispatcher.
6. Smokes: import real de fixtures de cada formato + ejecución de una colección importada.

## Tareas

- [x] **T1 — Motor de interchange** (`src/core/interchange.ts`) ✅
  - [x] `CollectionFormat`, `DetectedFormat`, `FORMATS` (etiquetas, extensiones),
        `detectFormat(text, fileName)` por contenido primero y extensión como respaldo
  - [x] `importCollection(text, fileName?)` con `ImportResult {collection, warnings}`
  - [x] Tests: los 6 formatos por huella + área + desconocido + errores (13 tests)
- [x] **T2 — Postman profundo + puente `pm`** ✅
  - [x] `postman.ts` (352 líneas): events raíz→colección / carpeta+petición→scripts con
        orden ancestro; query→`params` (array `query` manda en `disabled`; prepara re-inserta);
        auth heredada raíz→carpeta→petición con `inherit`; warnings para auth no soportada;
        export v2.1 re-emite events y url como objeto conservando `disabled`
  - [x] `pm.ts` (311): `createPm` + `createPostmanLegacy` — chai-subset (`equal/eql/include/
        property/oneOf/match/above/below/not/length`), `pm.response.to.have.status(200)` +
        `be.ok/json/oneOf`, `pm.environment/variables.replaceIn`, `pm.request.addHeader`
        que fluye de vuelta al motor; inyectado en `runScript` junto a `omnium`
  - [x] Tests: 5 de puente `pm` + 4 de Postman (events, query/disabled, auth heredada+warnings,
        roundtrip import→export→import)
  - [x] Bug propio atrapado: `??` no cae con string vacío en `joinScripts`; raíz duplicada
        en cada petición (el motor ya corre colección por petición) — corregido con test
- [x] **T3 — Insomnia (v4 JSON + v5 YAML)** ✅
  - [x] `yamlMini.ts` (362 líneas, sin dependencias): mapas/secuencias por sangría (incluye
        secuencia a la misma sangría de su clave), escalares planos/citados, flow `[..]`/`{..}`,
        bloques `|`/`|-`/`>` con chomping, comentarios, `---`; errores con número de línea
  - [x] `insomnia.ts` (392): `__export_format: 3|4` (resources, JSON o YAML) y v5
        (`collection.insomnia.rest/5.0`, YAML o JSON serializado); carpetas → prefijo;
        ambiente base → variables, sub-entornos → avisos; `{{ _.x }}` → `{{x}}`;
        scripts `preRequest`/`afterResponse` multilínea; auth basic/bearer/apikey y
        aviso para oauth2/etc.; API `insomnia.*` → aviso honesto (usa pm/omnium);
        export v4 JSON reconstruyendo carpetas desde el prefijo ` / `
  - [x] Tests: 11 yamlMini + 4 insomnia (v4 con avisos, v5 con script multilínea y body
        en bloque, roundtrip import→export→import, dispatcher) + 2 de detección
  - [x] Bugs propios atrapados: export omitía peticiones de raíz; `vars()` dejaba espacio
        sobrante en `{{base_url }}`; orden carpetas/raíz en el roundtrip
- [x] **T4 — Bruno (`.bru`)** ✅
  - [x] Parser `bruno.ts` (438): bloques `etiqueta { … }` con cierre en columna 0;
        `meta` (ignora `tags`), método/`http` (método custom → aviso + GET),
        `params:query`/`params:path` (`~` deshabilitado, `:clave` sustituida en URL),
        `headers`, `auth:*` (bearer/basic/apikey; oauth2/inherit → aviso),
        `body:*` (json/text/xml → crudo dedent; form-urlencoded/multipart → pares;
        graphql → texto + aviso), `script:pre-request`/`post-response`, `assert`
        → aserciones nativas (`$res.status`, `$res.body.x`, `$res.headers.x`, ops
        eq/notEq/contains/isDefined/gt…), `docs` → descripción, `settings.
        followRedirects`; `tests`/`vars:*` → aviso (API bru.*); `folder.bru` → error claro
  - [x] Export: `exportBru(request)` → un `.bru` por petición (meta, método,
        params/headers con `~`, auth, body, scripts, assert, settings, docs)
  - [x] Tests: fixture completo (bearer + 3 asserts + scripts + ~disabled),
        roundtrip, avisos oauth2/tests, folder error, params:path + método custom
  - [x] **Límite documentado (Progreso)**: la exportación Bruno es un archivo por
        petición y NO recrea carpetas/`bruno.json` (Bruno no importa `.bru` sueltos;
        el usuario los coloca en su colección existente)
- [ ] **T5 — JMeter (`.jmx`)**
  - [ ] Parser dirigido de XML (tags conocidos, sin dependencia): ThreadGroup → colección,
        HTTPSamplerProxy → petición (método/dominio/puerto/ruta/query), headers, body,
        ResponseAssertion → aserciones, CSVDataSet → variables
  - [ ] Tests: fixture JMX con2 samplers + assertion + CSV
- [ ] **T6 — Hoppscotch + Thunder Client**
  - [ ] `hoppscotch.ts`: export JSON (`v`, `items` recursivos con folders)
  - [ ] `thunder.ts`: export JSON (`_type: request-import`, `requests` / colección)
  - [ ] Tests por formato (fixture de cada uno)
- [ ] **T7 — UI: importar/exportar**
  - [ ] Comando único "Importar colección…" (auto-detección + selector de formato + avisos);
        reemplaza el kind fijo `postman` de `beginImport`
  - [ ] Comando "Exportar colección…" → Postman JSON / Insomnia v4 / Bruno `.bru`
        (descarga por formato)
  - [ ] Tests de estado donde aplique; verificación visual documentada como pendiente
- [ ] **T8 — CLI con auto-detección**
  - [ ] `loadTarget` usa `importCollection` (cualquier formato directo en `omnium run archivo`)
- [ ] **T9 — Cierre**: smokes por formato, greps, docs (Progreso + tabla de slices), commits

## Forecast de líneas autoradas

| Slice | Contenido | Estimación | PR |
|---|---|---|---|
| T1+T2 | motor + Postman + puente pm | ~700 | PR21 |
| T3 | Insomnia + yamlMini | ~450 | PR22 |
| T4+T5 | Bruno + JMeter | ~500 | PR23 |
| T6 | Hoppscotch + Thunder | ~250 | PR24 |
| T7+T8+T9 | UI + CLI + cierre | ~450 | PR25 |
| **Total** | | **~2350** | chain `stacked-to-main` ya cacheada |

## No-objetivos (explícitos)

- Export a JMeter/Hoppscotch/Thunder Client; export de área a Insomnia (área = workspace).
- Plan de carga desde JMX (hasta que `Collection` tenga campo de plan).
- Compatibilidad total de chai en el puente `pm` (solo el subconjunto observado en colecciones reales).

## Progreso

- **Límite de exportación Bruno** (definido en T4): un `.bru` por petición
  (descarga por archivo); no se recrean carpetas ni `bruno.json` — Bruno no
  importa `.bru` sueltos, el usuario los coloca en su colección existente.

- [x] Exploración (postman.ts, script.ts, tipos, UI/CLI actuales) y decisión de alcance
- [x] Documento creado (antes de la primera escritura de código)
- [x] T1+T2 ✅ (99/99 tests, tsc + build verdes) → T3 → T9
- [x] T3 ✅ (115/115 tests, tsc + build verdes) → T4
- [x] T4 ✅ (120/120 tests, tsc + build verdes) → T5
