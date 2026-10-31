# ADR-000: Matriz Comparativa de Proyectos Open Source de Referencia

**Estado:** Aprobado (Fase 0)  
**Fecha:** 2026-10-31  
**Contexto:** Evaluación técnica de los 6 proyectos candidatos identificados en `agents/AGENTS.md` (Sección 13 y 16) para determinar qué patrones e implementaciones reutilizar, qué adaptar y qué desarrollar a medida para **Product Owner CLI (PO CLI)**.

---

## 1. Análisis Individual de Candidatos

### 1.1. Slipwright (`ksksertac/slipwright`)
* **Propósito:** Equipo de desarrollo asistido por IA autoalojado con modelo de *human-in-the-loop gating*.
* **Arquitectura y modelo de agentes:** Define roles explícitos (*Product Owner, Architect, Builders/Specialists, QA, DevOps*) coordinados por una máquina de estados determinista. Cada salida de agente se valida contra esquemas tipados.
* **Fortalezas clave:**
  * Gates de aprobación humana explícitos en cada hito (Backlog, Arquitectura, Casos de Prueba, Código).
  * Salidas estructuradas por esquema tipado para evitar mutaciones descontroladas.
* **Limitaciones para PO CLI:**
  * Orientado a un centro de control Web (`localhost:8500` en contenedor Docker) en lugar de una experiencia TUI/CLI nativa de terminal.
  * El rol de Product Owner es asumido parcialmente por un agente generador de backlog, mientras que en PO CLI el **Product Owner es el humano** y el Arquitecto es su interlocutor técnico principal.
  * Carece del concepto de **Notebooks de conocimiento** gestionados en el filesystem con RAG trazable.

### 1.2. CLI Agent Orchestrator — CAO (`awslabs/cli-agent-orchestrator`)
* **Propósito:** Orquestador jerárquico de AWS Labs para coordinar múltiples agentes CLI (Claude Code, Kiro, Codex) en sesiones aisladas.
* **Arquitectura y modelo de agentes:** Modelo supervisor/trabajador (*lead agent* + *worker agents*) ejecutándose en sesiones `tmux` aisladas y comunicándose mediante herramientas MCP.
* **Fortalezas clave:**
  * Gestión de perfiles de agentes y aislamiento de sesiones de terminal en Linux.
  * Integración de MCP para coordinación y delegación.
* **Limitaciones para PO CLI:**
  * Depende de envolver CLIs de terceros mediante `tmux` (scraping/inyección en terminal), lo que introduce fragilidad frente a un protocolo estructurado `JSON-RPC 2.0` sobre `stdio`.
  * No implementa una máquina de estados SDLC con artefactos normativos ni la regla de autoridad `Desarrollador → consulta obligatoria → Arquitecto → Product Owner`.

### 1.3. Open Orchestra (`0xSero/orchestra` y patrones derivados)
* **Propósito:** Orquestación multiagente *hub-and-spoke* (Conductor + Subagentes especialistas) integrada con entornos como OpenCode y flujos basados en especificaciones.
* **Fortalezas clave:**
  * Separación entre especificación técnica y ejecución.
  * Uso de *playbooks* por rol y aislamiento mediante *git worktrees*.
* **Limitaciones para PO CLI:**
  * El modelo *hub-and-spoke* puro centraliza toda conversación en un "Conductor" opaco, impidiendo la comunicación directa e interactiva del usuario con cada profesional (`PO ↔ Arquitecto`, `PO ↔ Desarrollador`, `PO ↔ QA`) y las consultas directas reguladas entre pares (`Desarrollador ↔ Arquitecto`).

### 1.4. TinySDLC (`Minh-Tam-Solution/tinysdlc`)
* **Propósito:** Orquestador minimalista en TypeScript que modela procesos de ingeniería con separación estricta de funciones (*Researcher, PM, Architect, Coder, Reviewer, Tester, DevOps*).
* **Fortalezas clave:**
  * Principio estricto de **No Self-Review** (el desarrollador nunca valida su propia entrega; QA/Tester es independiente).
  * Cola de mensajes basada en archivos sencilla de auditar.
* **Limitaciones para PO CLI:**
  * Demasiados roles granulares (8 roles) para el equipo nuclear inicial, lo que añade latencia burocrática innecesaria frente a la tríada óptima (`Arquitecto`, `Desarrollador`, `QA`).
  * Sin sistema RAG ni Notebooks de usuario.

### 1.5. Pi (`badlogic/pi-mono`)
* **Propósito:** Toolkit y agente de programación minimalista en TypeScript con TUI ultrarrápida.
* **Fortalezas clave:**
  * **Agent Loop limpio y minimalista:** Prompts de sistema concisos, bajo consumo de tokens, ejecución directa de herramientas y excelente soporte para modelos locales y remotos.
  * Estructura de sesiones ramificable y extensible mediante TypeScript.
* **Limitaciones para PO CLI:**
  * Es un *single-agent coding assistant*, no un entorno de equipo de ingeniería con roles, artefactos versionados ni ciclo formal de QA.

### 1.6. OpenCode (`anomalyco/opencode`)
* **Propósito:** Entorno de desarrollo asistido por IA en terminal con arquitectura cliente/servidor local, soporte MCP y sistema de permisos.
* **Fortalezas clave:**
  * Excelente referencia de UX en terminal (paneles de estado, streaming de herramientas, permisos explícitos para comandos peligrosos e integración con MCP).
  * Separación limpia entre el servidor de runtime local y la interfaz TUI.
* **Limitaciones para PO CLI:**
  * Sus agentes (`plan` / `build`) son modos de edición de código, no profesionales con responsabilidad colegiada, auditoría de desviaciones arquitectónicas ni bases de conocimiento tipo Notebook.

---

## 2. Matriz Comparativa (16 Criterios de `AGENTS.md`)

| Criterio | Slipwright | AWS CAO | Open Orchestra | TinySDLC | Pi (`pi-mono`) | OpenCode | **Decisión para PO CLI** |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **1. Arquitectura interna** | Coordinador + Workers + Web UI | Supervisor sobre `tmux` + MCP | Hub-and-spoke plugin | Basado en colas de archivos | Monorepo TS modular | Servidor local + Cliente TUI | **Orquestador Core + Procesos Agente vía JSON-RPC + TUI Ink desacoplada** |
| **2. Lenguaje y stack** | TS / Node / Docker | Python / CLI | TS / YAML | TypeScript / Node | TypeScript / Node | Go + TypeScript | **TypeScript sobre Node.js 24 LTS en Linux** |
| **3. Modelo de agentes** | 5 roles SDLC | Jerárquico libre | Conductor + Workers | 8 roles SDLC | Agente único extensible | Agente Build / Plan + Subagentes | **3 roles nucleares (`Arquitecto`, `Desarrollador`, `QA`) + extensible** |
| **4. Agent Loop y Runtime** | Basado en pasos tipados | Delegado al CLI externo | Delegado al host | Básico por turnos | Loop iterativo minimalista | Loop completo con permisos | **Inspirado en Pi (minimalista y tipado con Zod)** |
| **5. Orquestación** | Máquina de estados determinista | Supervisor LLM | Conductor central | Cadena secuencial / fan-out | N/A | Sub-tareas síncronas | **Máquina de estados determinista (8 fases) + enrutador de autoridad** |
| **6. Gestión de sesiones** | Persistida en volumen | Sesiones `tmux` | Por tarea | Archivos JSON/MD | Árbol de sesiones | SQLite / Archivos locales | **SQLite nativo (`node:sqlite`) con sesiones por rol e inter-agente** |
| **7. Comunicación inter-agente** | Handoff por estado | MCP / `tmux` | Vía Conductor | Cola de archivos | N/A | Retorno a agente padre | **Protocolo explícito (`consult_architect`, `submit_for_qa`, `submit_qa_report`)** |
| **8. Workflows y estados** | Gated pipeline | Ad-hoc | Basado en playbooks | Secuencial por rol | Libre | Libre | **8 Fases formales con ciclo de corrección QA ↔ Dev ↔ Arch** |
| **9. Aprobaciones humanas** | Sí (Web Gates) | Manual en CLI | Opcional | Opcional | Permisos de tool | Permisos de tool | **Gates de dominio en TUI (Aprobación de Arquitectura, Enmiendas y Aceptación Final)** |
| **10. Integración MCP** | Limitada | Sí (Nativa) | Sí | No | Vía extensiones | Sí (Nativa) | **Cliente MCP JSON-RPC en Runtime con permisos por rol** |
| **11. Memoria y RAG** | Contexto de fase | Sin RAG propio | Archivos de spec | Archivos MD | Contexto en sesión | Indexación de código | **4 capas de memoria + Notebooks en Filesystem con RAG híbrido (FTS5 + Vector)** |
| **12. TUI / CLI** | No (Web UI) | CLI + `tmux` | Depende del host | CLI básico | TUI rápida | TUI avanzada | **Ink (React for CLI) como Centro de Mando multipanel** |
| **13. Persistencia** | DB en Docker | Sistema de archivos | Archivos locales | Archivos locales | JSONL en disco | SQLite / JSON | **SQLite (`node:sqlite`) + Artefactos versionados con SHA-256 en Filesystem** |
| **14. Licencia** | Open Source / Self-hosted | Apache-2.0 | MIT | MIT | MIT | MIT | **Compatible (adoptamos patrones y librerías MIT/Apache-2.0)** |
| **15. Actividad** | Activo | Activo (AWS Labs) | Variable | Experimental | Muy activo | Muy activo | **Sin dependencia bloqueante de frameworks monolíticos** |
| **16. Reutilización en PO CLI** | Patrón de Gates + Schemas | Patrón de aislamiento de procesos | Patrón de Handoff de specs | Regla *No Self-Review* | Diseño del Agent Loop | Patrón de permisos y UX TUI | **Combinación selectiva sobre arquitectura propia** |

---

## 3. Veredicto: Qué Reutilizar, Qué Adaptar y Qué Desarrollar

1. **Qué reutilizar directamente (Librerías maduras):**
   * **Node.js 24 Built-in SQLite (`node:sqlite`) + FTS5:** Persistencia relacional, historial de sesiones, auditoría de aprobaciones y búsqueda léxica BM25 sin dependencias C++ externas.
   * **Zod:** Validación estricta de esquemas para contratos IPC (`JSON-RPC 2.0`), llamadas a herramientas y artefactos.
   * **Ink + React:** Capa de presentación TUI declarativa y desacoplada del Core.
   * **Herramientas nativas de Linux (`child_process`, `bwrap` / Bubblewrap, `podman`, `fs.watch`/inotify):** Ejecución de procesos, aislamiento por namespaces/contenedores OCI y vigilancia de archivos en Notebooks.
2. **Qué adaptar conceptualmente:**
   * De **Pi (`pi-mono`)**: El diseño de un *Agent Loop* ligero, predecible y sin sobrecarga de frameworks pesados como LangChain.
   * De **Slipwright** y **TinySDLC**: La máquina de estados con *gates* humanos y la separación estricta entre quien implementa (Desarrollador) y quien certifica con evidencias (QA).
   * De **OpenCode**: La separación entre el motor de runtime/eventos y la interfaz TUI.
3. **Qué desarrollar como valor diferencial de PO CLI:**
   * El **Modelo de Autoridad Tripartito** supervisado por el Product Owner humano (`PO ↔ Arquitecto ↔ Desarrollador ↔ QA`), incluyendo el bloqueo de cambios arquitectónicos unilaterales y el flujo formal de consulta y enmienda (`consult_architect` / `request_architecture_amendment`).
   * El **Sistema de Artefactos Normativos Versionados** con trazabilidad bidireccional (`Requisito ↔ ADR/Arquitectura ↔ Código ↔ Caso de Prueba / Informe QA`).
   * El **Sistema de Notebooks de Conocimiento en Filesystem** conectados al motor RAG híbrido con control de acceso por rol y citas verificables.

