# Product Owner CLI (`pocli`)

Entorno TUI/CLI nativo en Linux para el desarrollo de software asistido por un **equipo virtual de ingeniería** (`Arquitecto de Software`, `Desarrollador Experto`, `Ingeniero de QA` y especialistas extensibles) dirigido por el **Product Owner humano**, con soporte de **Notebooks de conocimiento RAG** en el filesystem y aislamiento de procesos.

---

## Arquitectura e Implementación (Fases 0 a 7)

* **Documentación y ADRs:**
  * [agents/AGENTS.md](agents/AGENTS.md) — Especificación maestra del producto.
  * [agents/IMPLEMENTATION_PLAN.md](agents/IMPLEMENTATION_PLAN.md) — Plan de implementación por fases.
  * [docs/adr/000-oss-benchmark-matrix.md](docs/adr/000-oss-benchmark-matrix.md) — Matriz comparativa de proyectos open source (*Slipwright, AWS CAO, Open Orchestra, TinySDLC, Pi, OpenCode*).
  * [docs/adr/001-architecture-and-runtime.md](docs/adr/001-architecture-and-runtime.md) — Arquitectura modular, IPC `JSON-RPC 2.0`, `node:sqlite` + `FTS5`, Notebooks RAG y Sandboxing en Linux.
* **Módulos principales (`src/`):**
  * `src/core/contracts.ts` & `src/core/workflow.ts`: Esquemas `Zod`, máquina de estados de las **8 fases del Workflow** y motor de reglas de autoridad (`AuthorityGuard`).
  * `src/storage/database.ts`: Persistencia desacoplada sobre `node:sqlite` (`WAL` + `FTS5`), artefactos versionados en disco con hashes `SHA-256`, historial de aprobaciones, consultas arquitectónicas, informes de QA y 4 capas de memoria.
  * `src/runtime/notebook-rag.ts`: Gestión de **Notebooks** asociados a directorios del filesystem, indexación incremental (`SHA-256`), vigilancia de cambios en Linux (`fs.watch`/inotify) y recuperación híbrida (`SQLite FTS5 BM25` + similitud vectorial coseno) con citas verificables.
  * `src/runtime/process-runner.ts` & `src/runtime/agent-worker.ts`: Ejecución de agentes en procesos independientes de Linux comunicados mediante `JSON-RPC 2.0` sobre `stdio`, soportando `LOCAL_PROCESS`, `LINUX_BWRAP` (namespaces vía Bubblewrap) y `OCI_CONTAINER`.
  * `src/runtime/mcp-client.ts`: Cliente Model Context Protocol (`MCP`) sobre `JSON-RPC 2.0` con permisos por rol.
  * `src/runtime/orchestrator.ts`: Orquestador central del equipo virtual y coordinación de artefactos, handoffs, consultas y ciclos de validación QA.
  * `src/tui/CommandCenterApp.tsx`: Centro de mando interactivo en terminal construido con **Ink**.

---

## Uso Rápido

```bash
# Ejecutar la suite de pruebas de integración (Fases 0 a 7)
npm test

# Ejecutar una demostración completa de las 8 fases del workflow en Linux
npx tsx src/cli.ts demo

# Iniciar el Centro de Mando interactivo TUI (Ink)
npm run tui

# Compilar a JavaScript en ./dist
npm run build
```
