# ADR-001: General Architecture, Linux Process Runtime, Persistence, and Hybrid RAG

**Status:** Approved (Phase 0)  
**Date:** 2026-10-31  
**Context:** Definition of module boundaries, data model, inter-process communication protocol on Linux, local persistence, multi-language support, and knowledge retrieval engine (Notebooks + RAG) for **Product Owner CLI (PO CLI)**.

---

## 1. Layered Modular Architecture

PO CLI is organized into four strictly decoupled TypeScript layers:

1. **`src/core/` (Domain, Contracts, State Machine, and i18n):**
   * `Zod` schemas for all system entities: Projects, Agents, Messages, Artifacts, Authority Consultations, QA Reports, Notebooks, and `JSON-RPC 2.0` IPC messages.
   * Deterministic state machine for the **8 Workflow Phases** and authority policy enforcement (`AuthorityGuard`).
   * Multi-language translation dictionary (`src/core/i18n.ts`) supporting English (`en`, default) and Spanish (`es`).
2. **`src/storage/` (Relational Persistence, Indexes, Settings, and Artifacts):**
   * Built on `node:sqlite` (`DatabaseSync` native to Node.js 24 with `FTS5` enabled).
   * Decoupled repositories for projects, sessions, messages, versioned artifacts (materialized on disk under `.pocli/artifacts/` with `SHA-256` hashes), inter-agent consultations, QA reports, 4-layer memory, Notebook chunks, and user settings (`settings` table).
3. **`src/runtime/` (Orchestrator, Agent Worker Processes, Harnesses, RAG, and MCP):**
   * **Agent Loop & LLM Gateway:** Iterative execution supporting per-role multi-model routing (`OpenAI`, `Anthropic`, `Gemini`, `Ollama`, and `DeterministicSpecialist` for offline/reproducible execution).
   * **Linux Execution Strategies (`LinuxAgentProcessRunner`):**
     * `LOCAL_PROCESS`: Runs in a separate OS process via `child_process` communicating over `JSON-RPC 2.0` on `stdio`.
     * `LINUX_BWRAP`: Native Linux sandboxing via `bwrap` (Bubblewrap / Linux user, mount, pid, and ipc namespaces), mounting the root filesystem read-only and restricting write access exclusively to the authorized project workspace.
     * `OCI_CONTAINER`: Isolated container execution via `podman`.
   * **Agent Harnesses:** Declarative configuration of instructions, artifact permissions, and tools for `architect`, `developer`, `qa`, and dynamically registered specialist roles.
   * **Notebook Hybrid RAG Engine:** Incremental `SHA-256` indexing, live file watching via `fs.watch` (Linux inotify), and hybrid retrieval (`FTS5 BM25` + semantic vector cosine similarity) with mandatory source citations.
   * **MCP Client:** Connects to Model Context Protocol servers over `JSON-RPC 2.0` `stdio` with per-role access control.
4. **`src/tui/` (Fullscreen Terminal Command Center with Ink):**
   * Pure presentation layer built with **Ink (React for CLI)** featuring an OpenCode-style clean startup screen, interactive `/` slash commands (including `/settings`), and `Ctrl+Tab` switching to the Multipanel Command Center.

---

## 2. IPC Protocol Between Orchestrator and Agent Processes

Each agent executes inside its own Linux OS process. Communication between the **Orchestrator** (parent process) and the **Agent Worker** (child process) uses **newline-delimited JSON-RPC 2.0 (`NDJSON`) over `stdin`/`stdout`**, reserving `stderr` for diagnostics:

* **Orchestrator → Agent Worker Requests:**
  * `agent.ping`: Health check returning worker PID and platform.
  * `agent.executeTurn`: Sends prompt, normative artifact summary, RAG citations from authorized Notebooks, and model configuration.
  * `agent.shutdown`: Graceful process termination.
* **Agent Worker → Orchestrator Notifications:**
  * `agent.streamChunk`: Real-time token streaming during turn generation.

---

## 3. Data Model and Artifact Traceability

No critical engineering decision remains buried exclusively in chat history. All work produces persistent, traceable artifacts:

* **`REQ-*`**: Functional and non-functional requirements.
* **`ADR-*`**: Architectural Decision Records authored by the Software Architect.
* **`ARCH-*`**: Technical architecture document and component contracts (subject to **Formal Product Owner Approval**).
* **`SPEC-*` / `PLAN-*`**: Technical specifications and implementation plans.
* **`CODE-*`**: Source code files linked to requirements and architecture.
* **`TEST-*` / `QA-*` / `DEF-*`**: Test cases, independent QA validation reports with execution evidence, and defects classified by severity (`LOW`, `MEDIUM`, `HIGH`, `CRITICAL`).

---

## 4. Knowledge Notebooks and Hybrid RAG Design

1. **Conceptual Separation:** Users manage **Notebooks** (physical directories on the Linux filesystem, global or project-scoped, linked N:M to projects). The underlying RAG indexing and vector math remain completely transparent.
2. **Incremental Indexing:** When a Notebook is indexed, the engine walks the directory recursively, computes the `SHA-256` hash of each file, and only re-chunks new or modified files.
3. **Structural Chunking:** Documents are split along Markdown headings and logical blocks while preserving `notebookId`, `notebookName`, `documentPath`, `section`, and line range (`L1-L42`).
4. **Hybrid Retrieval:** Combines lexical relevance (`SQLite FTS5 BM25`) with semantic n-gram vector cosine similarity, strictly filtered by active Notebooks linked to the project and authorized for the querying agent's role.
