# ADR-000: Open Source Reference Projects Benchmark Matrix

**Status:** Approved (Phase 0)  
**Date:** 2026-10-31  
**Context:** Technical evaluation of the 6 candidate open-source projects identified in `agents/AGENTS.md` (Sections 13 and 16) to determine which patterns and components to reuse, adapt, or build from scratch for **Product Owner CLI (PO CLI)**.

---

## 1. Individual Candidate Analysis

### 1.1. Slipwright (`ksksertac/slipwright`)
* **Purpose:** Self-hosted AI software development team framework built around a *human-in-the-loop gating* model.
* **Architecture & Agent Model:** Defines explicit roles (*Product Owner, Architect, Builders/Specialists, QA, DevOps*) coordinated by a deterministic state machine. Every agent response is validated against typed schemas.
* **Key Strengths:**
  * Explicit human approval gates at major milestones (Backlog, Architecture, Test Cases, Code).
  * Typed schema validation for agent outputs to prevent uncontrolled mutations.
* **Limitations for PO CLI:**
  * Designed around a Dockerized Web UI (`localhost:8500`) rather than a native Linux terminal TUI/CLI.
  * Delegates part of the Product Owner role to an AI backlog agent, whereas in PO CLI the **human user is the Product Owner** and the Architect is the primary technical interlocutor.
  * Lacks user-managed **Knowledge Notebooks** on the filesystem with traceable RAG citations.

### 1.2. CLI Agent Orchestrator — CAO (`awslabs/cli-agent-orchestrator`)
* **Purpose:** Hierarchical orchestrator by AWS Labs designed to coordinate multiple CLI coding assistants (Claude Code, Kiro, Codex) in isolated sessions.
* **Architecture & Agent Model:** Supervisor/worker model (*lead agent* + *worker agents*) running inside isolated `tmux` sessions and communicating through MCP tools.
* **Key Strengths:**
  * Agent profile management and terminal session isolation on Linux.
  * Native MCP integration for coordination and task delegation.
* **Limitations for PO CLI:**
  * Relies on wrapping third-party CLIs via `tmux` terminal scraping/injection, which is fragile compared to a structured `JSON-RPC 2.0` protocol over `stdio`.
  * Does not enforce an SDLC state machine with normative artifacts or the authority rule `Developer → mandatory consultation → Architect → Product Owner`.

### 1.3. Open Orchestra (`0xSero/orchestra` and related patterns)
* **Purpose:** *Hub-and-spoke* multi-agent orchestration (Conductor + Specialist subagents) integrated with environments like OpenCode and spec-driven workflows.
* **Key Strengths:**
  * Separation between technical specification and code execution.
  * Role playbooks and isolation via *git worktrees*.
* **Limitations for PO CLI:**
  * A pure *hub-and-spoke* model routes all interaction through an opaque "Conductor", preventing direct interactive conversations between the user and each professional (`PO ↔ Architect`, `PO ↔ Developer`, `PO ↔ QA`) as well as regulated peer consultations (`Developer ↔ Architect`).

### 1.4. TinySDLC (`Minh-Tam-Solution/tinysdlc`)
* **Purpose:** Minimalist TypeScript orchestrator modeling software engineering workflows with strict separation of duties (*Researcher, PM, Architect, Coder, Reviewer, Tester, DevOps*).
* **Key Strengths:**
  * Strict **No Self-Review** principle (the developer never grades their own delivery; QA/Tester is independent).
  * Simple, auditable file-based message queue.
* **Limitations for PO CLI:**
  * Too many granular roles (8 roles) for the initial core team, adding unnecessary latency compared to the optimal triad (`Architect`, `Developer`, `QA`).
  * No built-in RAG engine or user Notebooks.

### 1.5. Pi (`badlogic/pi-mono`)
* **Purpose:** Minimalist TypeScript AI coding agent toolkit with a fast TUI.
* **Key Strengths:**
  * **Clean, minimalist Agent Loop:** Concise system prompts, low token overhead, direct tool execution, and strong support for both local and remote models.
  * Branchable session tree and TypeScript extensibility.
* **Limitations for PO CLI:**
  * Single-agent coding assistant rather than a multi-role engineering team environment with versioned artifacts and formal QA cycles.

### 1.6. OpenCode (`anomalyco/opencode`)
* **Purpose:** Terminal-based AI development environment featuring a local client/server architecture, MCP support, and a permissions system.
* **Key Strengths:**
  * Benchmark terminal UX (clean centered startup banner, `/` slash commands, tool streaming, explicit permissions, and MCP integration).
  * Clean separation between the local runtime engine and the TUI presentation layer.
* **Limitations for PO CLI:**
  * Its built-in agents (`plan` / `build`) are code editing modes rather than distinct engineering roles with authority boundaries, architectural deviation audits, and Notebook knowledge bases.

---

## 2. Comparative Matrix (16 Criteria from `AGENTS.md`)

| Criterion | Slipwright | AWS CAO | Open Orchestra | TinySDLC | Pi (`pi-mono`) | OpenCode | **Decision for PO CLI** |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **1. Internal Architecture** | Coordinator + Workers + Web UI | Supervisor over `tmux` + MCP | Hub-and-spoke plugin | File-based queue | Modular TS monorepo | Local server + TUI client | **Core Orchestrator + Agent Processes via JSON-RPC + Decoupled Ink TUI** |
| **2. Language & Stack** | TS / Node / Docker | Python / CLI | TS / YAML | TypeScript / Node | TypeScript / Node | Go + TypeScript | **TypeScript on Node.js 24 LTS on Linux** |
| **3. Agent Model** | 5 SDLC roles | Free hierarchy | Conductor + Workers | 8 SDLC roles | Single extensible agent | Build / Plan + Subagents | **3 core roles (`Architect`, `Developer`, `QA`) + extensible** |
| **4. Agent Loop & Runtime** | Typed step execution | Delegated to external CLI | Delegated to host | Basic turn-based | Minimalist iterative loop | Full loop with permissions | **Inspired by Pi (minimalist and typed with Zod)** |
| **5. Orchestration** | Deterministic state machine | LLM Supervisor | Central Conductor | Sequential chain / fan-out | N/A | Synchronous subtasks | **Deterministic state machine (8 phases) + authority router** |
| **6. Session Management** | Volume-persisted | `tmux` sessions | Per task | JSON/MD files | Session tree | SQLite / Local files | **Native SQLite (`node:sqlite`) with role & inter-agent sessions** |
| **7. Inter-Agent Comms** | State handoff | MCP / `tmux` | Via Conductor | File queue | N/A | Return to parent agent | **Explicit protocol (`consult_architect`, `submit_for_qa`, `submit_qa_report`)** |
| **8. Workflows & States** | Gated pipeline | Ad-hoc | Playbook-driven | Role-sequential | Freeform | Freeform | **8 Formal phases with QA ↔ Dev ↔ Arch correction loop** |
| **9. Human Approvals** | Yes (Web Gates) | Manual in CLI | Optional | Optional | Tool permissions | Tool permissions | **Domain Gates in TUI (Architecture Approval, Amendments, Final Acceptance)** |
| **10. MCP Integration** | Limited | Yes (Native) | Yes | No | Via extensions | Yes (Native) | **JSON-RPC MCP Client in Runtime with per-role permissions** |
| **11. Memory & RAG** | Phase context | No native RAG | Spec files | MD files | Session context | Code indexing | **4-layer memory + Filesystem Notebooks with Hybrid RAG (FTS5 + Vector)** |
| **12. TUI / CLI** | No (Web UI) | CLI + `tmux` | Host-dependent | Basic CLI | Fast TUI | Advanced TUI | **Ink (React for CLI) with Clean OpenCode View + Multipanel Command Center** |
| **13. Persistence** | Docker DB | Filesystem | Local files | Local files | Disk JSONL | SQLite / JSON | **SQLite (`node:sqlite`) + SHA-256 Versioned Artifacts on Filesystem** |
| **14. License** | Open Source / Self-hosted | Apache-2.0 | MIT | MIT | MIT | MIT | **Compatible (adopting patterns and MIT/Apache-2.0 libraries)** |
| **15. Maintenance** | Active | Active (AWS Labs) | Variable | Experimental | Very active | Very active | **No blocking dependency on monolithic frameworks** |
| **16. Reuse in PO CLI** | Gates + Schemas pattern | Process isolation pattern | Spec handoff pattern | *No Self-Review* rule | Agent Loop design | TUI UX & `/` commands | **Selective combination on a dedicated architecture** |

---

## 3. Verdict: What to Reuse, What to Adapt, and What to Build

1. **Direct Reuse (Mature Libraries & Platform Capabilities):**
   * **Node.js 24 Built-in SQLite (`node:sqlite`) + FTS5:** Relational persistence, session history, approval audit logs, application settings, and BM25 lexical search with zero native C++ addon build issues.
   * **Zod:** Strict schema validation for IPC contracts (`JSON-RPC 2.0`), tool calls, and domain artifacts.
   * **Ink + React:** Declarative TUI presentation layer decoupled from Core and Runtime.
   * **Linux Native Capabilities (`child_process`, `bwrap` / Bubblewrap, `podman`, `fs.watch`/inotify):** Process management, namespace/OCI sandboxing, and live Notebook directory monitoring.
2. **Conceptual Adaptation:**
   * From **Pi (`pi-mono`)**: Lightweight, predictable *Agent Loop* without heavy framework overhead.
   * From **Slipwright** and **TinySDLC**: Deterministic state machine with human gates and strict separation between implementation (Developer) and evidence-based verification (QA).
   * From **OpenCode**: Clean fullscreen startup experience with centered banner, interactive `/` slash commands, and runtime-to-TUI decoupling.
3. **Custom Development (Core PO CLI Differentiation):**
   * **Tripartite Authority Model** supervised by the human Product Owner (`PO ↔ Architect ↔ Developer ↔ QA`), enforcing unilateral architectural change blocks and formal consultation/amendment flows.
   * **Versioned Normative Artifact System** with bidirectional traceability (`Requirement ↔ ADR/Architecture ↔ Source Code ↔ Test Case / QA Report`).
   * **Filesystem Knowledge Notebooks** integrated with the hybrid RAG engine, role-based access control, and mandatory source citations.
