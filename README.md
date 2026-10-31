<div align="center">
<pre>
██████╗  ██████╗      ██████╗██╗     ██╗
██╔══██╗██╔═══██╗    ██╔════╝██║     ██║
██████╔╝██║   ██║    ██║     ██║     ██║
██╔═══╝ ██║   ██║    ██║     ██║     ██║
██║     ╚██████╔╝    ╚██████╗███████╗██║
╚═╝      ╚═════╝      ╚═════╝╚══════╝╚═╝
</pre>

# POCLI

> **The open-source AI dev team in your terminal — with you as the Product Owner.**

> *POCLI connects human product vision with autonomous AI agents to design, spec, and build software from the command line.*

</div>

A native Linux TUI/CLI software engineering environment powered by a **virtual team of specialized AI agents** (`Software Architect`, `Senior Developer`, `Independent QA Engineer`, `Project Manager (PM)`, and extensible specialists) directed by the **human Product Owner**, featuring filesystem **RAG Knowledge Notebooks**, multi-language support (`en` / `es`), and OS-level process sandboxing.

---

## Virtual Engineering Team & Authority Model

In **POCLI**, the **human user is the Product Owner** and retains final authority over the project, working alongside four permanently active virtual specialists:

* **Software Architect (`architect`):** Primary technical interlocutor. Analyzes requirements, proposes architectural options and trade-offs, records ADRs (`ADR-*`), authors the reference architecture (`ARCH-*`) and specifications (`SPEC-*`), and evaluates developer consultations. Never marks an architecture as approved without explicit Product Owner approval.
* **Senior Developer (`developer`):** Implements code (`CODE-*`) and plans (`PLAN-*`) strictly from the approved architecture handoff bundle. Cannot unilaterally modify architectural decisions; must use `consult_architect` when encountering ambiguities or blockers.
* **Independent QA Engineer (`qa`):** Independently verifies deliverables against requirements and acceptance criteria by executing real verification checks, capturing evidence, classifying defects (`DEF-*`), and issuing `ACCEPT` or `REJECT` verdicts (`QA-*`).
* **Project Manager (`pm`):** Queries permanently active agents (`Architect`, `Developer`, `QA`) at any time using **Parallel Inquiries** (simultaneous status collection across multiple agents) or **Sequential Inquiries** (chained inquiries where each agent's answer contextualizes the next question). Consolidates individual responses, detects cross-agent discrepancies, and reports back to the Product Owner—without authority to direct, modify, or interrupt the agents' engineering work.

---

## Architecture & Implementation (Phases 0 to 7)

* **Documentation & ADRs:**
  * [agents/AGENTS.md](agents/AGENTS.md) — Master product specification.
  * [agents/IMPLEMENTATION_PLAN.md](agents/IMPLEMENTATION_PLAN.md) — Phased implementation plan.
  * [docs/adr/000-oss-benchmark-matrix.md](docs/adr/000-oss-benchmark-matrix.md) — Open-source reference benchmark matrix (*Slipwright, AWS CAO, Open Orchestra, TinySDLC, Pi, OpenCode*).
  * [docs/adr/001-architecture-and-runtime.md](docs/adr/001-architecture-and-runtime.md) — Modular architecture, `JSON-RPC 2.0` IPC, `node:sqlite` + `FTS5`, RAG Notebooks, and Linux sandboxing.
* **Core Modules (`src/`):**
  * `src/core/contracts.ts`, `src/core/workflow.ts`, & `src/core/i18n.ts`: `Zod` domain schemas, the **8-phase Workflow state machine**, authority policy enforcement (`AuthorityGuard`), and multi-language (`en`/`es`) dictionary.
  * `src/storage/database.ts`: Decoupled persistence built on `node:sqlite` (`WAL` + `FTS5`), versioned artifacts materialized on disk with `SHA-256` hashes, approval history, architectural consultations, QA reports, 4-layer memory, and persisted application settings.
  * `src/runtime/notebook-rag.ts`: Management of **Notebooks** mapped to filesystem directories, incremental `SHA-256` indexing, live file watching on Linux (`fs.watch`/inotify), and hybrid retrieval (`SQLite FTS5 BM25` + vector cosine similarity) with verifiable source citations.
  * `src/runtime/process-runner.ts` & `src/runtime/agent-worker.ts`: Execution of agents in independent Linux OS processes communicating via `JSON-RPC 2.0` over `stdio`, supporting `LOCAL_PROCESS`, `LINUX_BWRAP` (Linux namespaces via Bubblewrap), and `OCI_CONTAINER`.
  * `src/runtime/mcp-client.ts`: Model Context Protocol (`MCP`) client over `JSON-RPC 2.0` with role-based permissions.
  * `src/runtime/orchestrator.ts`: Central orchestrator coordinating the virtual engineering team, artifacts, handoffs, consultations, and QA validation cycles.
  * `src/tui/CommandCenterApp.tsx`: Fullscreen terminal UI built with **Ink**, featuring an OpenCode-style clean startup view, interactive `/` slash command menu (including `/settings` for switching between English and Spanish), and `Ctrl+Tab` toggle to the Multipanel Command Center.

---

## Quick Start

```bash
# Run the integration test suite (Phases 0 to 7)
npm test

# Run a full 8-phase engineering workflow demonstration on Linux
npx tsx src/cli.ts demo

# Launch the interactive fullscreen TUI Command Center (Ink)
npm run tui

# Build TypeScript to ./dist
npm run build
```

---

## Interactive TUI Controls & Slash Commands

* Press **`Ctrl+Tab`** at any time to toggle between the **Clean OpenCode View** and the **Multipanel Command Center**.
* Type **`/`** in the prompt input box to open the interactive command menu:
  * `/project` — Interactive wizard (or inline `/project <name> <directory>`) to create a new project in a filesystem directory, initialize `.pocli/artifacts`, automatically discover and register any existing repositories inside that directory, and set it as the active project.
  * `/projects` — List all existing projects in SQLite with their `[ACTIVE]` status, phase, filesystem directory, and discovered repositories, allowing interactive project switching with `↑`/`↓` + `Enter`.
  * `/switch` — Switch the active project by name or ID (`/switch <name-or-id>`) or open the interactive project selector.
  * `/architect`, `/developer`, `/qa`, `/pm` — Switch active professional interlocutor (or run parallel/sequential PM inquiries).
  * `/propose` — Request a formal architecture and requirements proposal from the Architect.
  * `/approve` / `/reject` — Formally approve or reject `ARCH-001` as Product Owner.
  * `/handoff` — Transfer the approved normative bundle to the Developer.
  * `/implement` — Instruct the Developer to implement the approved handoff.
  * `/consult` — Trigger a formal Developer → Architect authority consultation.
  * `/validate` — Execute independent QA validation tests and collect evidence.
  * `/accept` — Final project acceptance by the Product Owner.
  * `/notebooks` — Re-index and inspect linked RAG Notebooks.
  * `/settings` — Open the interactive Settings modal or switch UI language (`/settings lang en` or `/settings lang es`).
  * `/help` — Display all available commands and keyboard shortcuts.
  * `/view`, `/clear`, `/exit`.
