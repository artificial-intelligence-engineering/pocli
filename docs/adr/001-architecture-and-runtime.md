# ADR-001: Arquitectura General, Runtime de Procesos en Linux, Persistencia y RAG

**Estado:** Aprobado (Fase 0)  
**Fecha:** 2026-10-31  
**Contexto:** Definición de los límites modulares, modelo de datos, protocolo de comunicación entre procesos en Linux, persistencia y motor de recuperación de conocimiento (Notebooks + RAG) para **Product Owner CLI (PO CLI)**.

---

## 1. Arquitectura Modular en Capas

PO CLI se estructura en cuatro capas estrictamente desacopladas dentro de TypeScript:

1. **`src/core/` (Dominio, Contratos y Máquina de Estados):**
   * Esquemas `Zod` para todas las entidades del sistema: Proyectos, Agentes, Mensajes, Artefactos, Consultas de Autoridad, Informes de QA, Notebooks y Protocolo `JSON-RPC 2.0`.
   * Máquina de estados de las **8 fases del Workflow** (`WorkflowStateMachine`) y validador de reglas de autoridad (`AuthorityPolicy`).
2. **`src/storage/` (Persistencia Relacional, Índices y Artefactos):**
   * Basado en `node:sqlite` (`DatabaseSync` nativo de Node.js 24 con soporte `FTS5`).
   * Repositorios desacoplados para proyectos, sesiones, mensajes, artefactos versionados (con copias físicas en `.pocli/artifacts/` y hashes `SHA-256`), consultas inter-agente, informes de QA, memoria multicapa y chunks de Notebooks.
3. **`src/runtime/` (Orquestador, Procesos Agente, Harnesses, RAG y MCP):**
   * **Agent Loop & LLM Gateway:** Ejecución iterativa con soporte multimodelo por rol (`OpenAI`, `Anthropic`, `Gemini`, `Ollama` y `DeterministicTeamSimulator` para pruebas reproducibles sin red).
   * **Estrategias de Ejecución en Linux (`ExecutionStrategy`):**
     * `LocalProcessStrategy`: Ejecución en proceso independiente mediante `child_process` comunicándose por `JSON-RPC 2.0` sobre `stdio`.
     * `LinuxBwrapStrategy`: Sandboxing nativo en Linux mediante `bwrap` (Bubblewrap / Linux namespaces), montando el sistema en solo lectura y restringiendo la escritura exclusivamente al workspace autorizado según el rol.
     * `ContainerExecutionStrategy`: Ejecución aislada en contenedores OCI mediante `podman`.
   * **Harnesses de Agentes:** Configuración declarativa de instrucciones, permisos sobre artefactos y herramientas para `architect`, `developer`, `qa` y roles extensibles.
   * **Motor RAG de Notebooks:** Indexación incremental por `SHA-256`, vigilancia de archivos con `fs.watch` (inotify en Linux) y búsqueda híbrida (`FTS5 BM25` + similitud coseno de vectores de embeddings) con citas obligatorias.
   * **Cliente MCP:** Conexión a servidores Model Context Protocol mediante `JSON-RPC 2.0` sobre `stdio` con control de acceso por rol.
4. **`src/tui/` (Centro de Mando en Terminal con Ink):**
   * Capa de presentación pura construida con **Ink (React para CLI)** + modo CLI por comandos (`pocli`) para automatización e inspección.

---

## 2. Protocolo IPC entre Orquestador y Procesos Agente

Cada agente puede ejecutarse en su propio proceso del sistema operativo Linux. La comunicación entre el **Orquestador** (proceso padre) y el **Worker del Agente** (proceso hijo) utiliza **JSON-RPC 2.0 delimitado por saltos de línea (`NDJSON`) sobre `stdin`/`stdout`**, reservando `stderr` para diagnóstico del sistema:

* **Peticiones del Orquestador al Proceso Agente:**
  * `agent.initialize`: Configura el *Harness* del rol, modelo asignado, workspace y permisos.
  * `agent.executeTurn`: Envía el prompt, contexto de artefactos aprobados, fragmentos RAG de Notebooks autorizados y herramientas permitidas.
  * `agent.shutdown`: Cierre ordenado del proceso.
* **Notificaciones y Peticiones del Proceso Agente al Orquestador:**
  * `agent.streamChunk`: Emisión en tiempo real de tokens de respuesta.
  * `agent.toolCall`: Solicitud o notificación de ejecución de herramienta auditada (`propose_requirement`, `write_architecture_doc`, `consult_architect`, `submit_for_qa`, `submit_qa_report`, `query_notebooks`, etc.).

---

## 3. Modelo de Datos y Trazabilidad de Artefactos

Ninguna decisión crítica queda enterrada en el historial de chat. Todo el flujo se apoya en artefactos persistentes con trazabilidad:

* **`REQ-*`**: Requisitos funcionales y no funcionales.
* **`ADR-*`**: Decisiones arquitectónicas registradas por el Arquitecto.
* **`ARCH-*`**: Documento de arquitectura y contratos de componentes (sujeto a **Aprobación Formal del Product Owner**).
* **`SPEC-*` / `PLAN-*`**: Especificaciones técnicas y plan de implementación.
* **`CODE-*`**: Archivos de código fuente e implementación asociados a requisitos y arquitectura.
* **`TEST-*` / `QA-*` / `DEF-*`**: Casos de prueba, informes de validación de QA con evidencias de ejecución y defectos clasificados por severidad (`LOW`, `MEDIUM`, `HIGH`, `CRITICAL`).
* **`CONSULT-*` / `AMEND-*`**: Consultas técnicas del Desarrollador al Arquitecto y solicitudes de modificación arquitectónica al Product Owner.

---

## 4. Diseño del Sistema de Notebooks y RAG Híbrido

1. **Separación conceptual:** El usuario gestiona **Notebooks** (directorios reales en el filesystem, locales o globales, asociados N:M a proyectos). El motor RAG es completamente transparente.
2. **Indexación incremental:** Al asociar o actualizar un Notebook, el indexador recorre recursivamente el directorio, calcula el hash `SHA-256` de cada archivo y solo re-procesa los archivos nuevos o modificados.
3. **Chunking estructural:** Los documentos se dividen respetando encabezados Markdown y bloques lógicos, conservando `notebookId`, `notebookName`, `filePath`, `sectionTitle` y rango de líneas.
4. **Recuperación híbrida:** Combina puntuación léxica exacta (`SQLite FTS5 BM25`) con similitud vectorial semántica, filtrando estrictamente por los notebooks activos asignados al proyecto y autorizados para el rol que realiza la consulta.

