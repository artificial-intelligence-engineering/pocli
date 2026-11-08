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

* **Software Architect (`architect`):** Primary technical interlocutor. Discusses vision and trade-offs, maintaining only two key versioned contract files: the Reference Architecture (`ARCH-*`) and Developer Specifications (`SPEC-*`). Never marks an architecture as approved without explicit Product Owner approval.
* **Senior Developer (`developer`):** Implements code (`CODE-*`) and maintains a technical implementation logbook (`IMP-*` in `contracts/implementation/`) strictly from the approved specification (`SPEC-*`) and architecture (`ARCH-*`). Cannot unilaterally modify architectural decisions; must use `consult_architect` when encountering ambiguities or blockers.
* **Independent QA Engineer (`qa`):** Independently verifies deliverables against requirements and acceptance criteria by executing real verification checks, capturing evidence, classifying defects (`DEF-*`), and issuing `ACCEPT` or `REJECT` verdicts (`QA-*`).
* **Project Manager (`pm`):** Queries permanently active agents (`Architect`, `Developer`, `QA`) at any time using **Parallel Inquiries** (simultaneous status collection across multiple agents) or **Sequential Inquiries** (chained inquiries where each agent's answer contextualizes the next question). Consolidates individual responses, detects cross-agent discrepancies, and reports back to the Product Owner—without authority to direct, modify, or interrupt the agents' engineering work.

---

## Performance & Token Efficiency: The Minimal Harness Philosophy

A core architectural principle of **POCLI** is extreme token efficiency and low latency, inspired by the minimalist design philosophy of **Pi** (*pi-agent*) and deliberately avoiding the prompt bloat seen in alternatives like OpenCode, Codex, or Claude Code—especially when running against local models (`llama.cpp`, Ollama) or rate-limited free tiers.

### Understanding the System Prompt

The **system prompt** is the baseline set of instructions and constraints defining the persona, behavioral boundaries, role permissions, and tooling available to the language model and its execution environment (*harness*) throughout an interaction:

* **Behavioral Directives:** Establishes the agent's identity, operational boundaries, and response formatting.
* **Persistent Transmission:** Injected and transmitted to the model provider on **every single conversational turn** to maintain continuous context and operational rules.
* **Prompt Processing Phase:** Prior to generating the first response token, the LLM inference server must sequentially ingest and index all system prompt instructions.

#### Why System Prompt Size is Critical

1. **Token Consumption & Incurred Costs:** Because it is included in every API call, an oversized system prompt imposes a heavy, recurring tax on your token quota with every conversational turn.
2. **Response Latency:** A large volume of initial instructions demands significantly more prompt processing time before generation can begin.
3. **Context Budget for the Project:** Tokens consumed by the system prompt permanently subtract from the total context window available for your actual project code, diffs, and files.

### 1. System Prompt Size & Specialization

| Environment | System Prompt Overhead | Design Approach |
| :--- | :--- | :--- |
| **Claude Code** | ~25,000 tokens | Monolithic rules, comprehensive checklists, tool manuals, and extensive style guides. |
| **OpenCode / Codex** | 10,000 – 15,000 tokens | Heavy multi-tool schemas, task manager prompts, and broad operational guidelines. |
| **Pi agent** | 500 – 900 tokens | Minimalist core behavioral guidelines. |
| **POCLI** | **150 – 250 tokens** | **Ultra-concise, role-scoped harnesses** (`Architect`: ~140 tokens, `Developer`: ~105 tokens, `QA`: ~70 tokens, `PM`: ~130 tokens). |

### 2. Prompt Processing Latency (TTFT) & 3-Tier Context Assembly

Before generating the first token, LLM inference engines must index the entire prompt. In OpenCode or Claude Code, sending even a simple greeting or status request forces the model to process 13,000+ tokens (often taking **up to 25 seconds** on local hardware or free-tier APIs).

In POCLI, the runtime assembles a **3-Tier Context Window** directly from SQLite:
* **Tier 1 (Cacheable Normative Prefix):** Only authoritative artifact codes, versions, and titles (`[REQ-001 v1 | APPROVED]`), rather than full document bodies.
* **Tier 2 (4-Layer Memory & Compaction Checkpoint):** Up to 8 high-priority persistent memories and the latest structured `/compact` summary.
* **Tier 3 (Active Recent Turns):** Strictly the last **6 uncompacted leaf turns** from the Session Tree DAG.

Total prompt payload remains between **600 and 1,200 tokens**, yielding a Time-To-First-Token (TTFT) of **under 1 second**.

### 3. "Minimal Harness" vs. Tool Bloat

Unlike frameworks that inject dozens of tool JSON schemas and UI state into every turn:
* The **Ink TUI** runs 100% locally in Node.js; modal dialogs, project switchers, and visual components never pollute the LLM's context.
* Tool availability is strictly bounded by role: `Independent QA Engineer` only receives 4 verification tools, `Senior Developer` receives 6, etc.

### 4. Isolated Subagent Inquiries with Clean Context

When the **Project Manager (PM)** executes parallel or sequential cross-agent inquiries (`query_agents_parallel` / `query_agents_sequential`), or when the Developer initiates a formal consultation with the Architect (`consult_architect`):
* The runtime spawns isolated worker turns in independent Linux processes.
* Inquiries receive only the targeted question and the normative Tier 1 prefix—**never dragging along the human Product Owner's full conversational history**.

### 5. Maximum Context Budget for Code & Artifacts

By constraining harness overhead to ~1,000 tokens, POCLI preserves **over 90–95% of the context window** (even on compact 8k/16k local models) exclusively for real source code, diffs, and RAG Knowledge Notebook citations.

### Technical Breakdown: Where and How System Prompts are Stored & Assembled

POCLI manages prompts through a decoupled two-layer architecture separating **immutable role definitions** from **dynamic, cache-friendly project state**:

#### 1. Decoupled Role Prompts (`behavior/system/*.md` & `src/runtime/harnesses.ts`)
The baseline behavioral prompt for each virtual engineering role is decoupled into standalone Markdown files under `behavior/system/`:
* `behavior/system/architect.md` — Software Architect directives and architecture/spec boundaries.
* `behavior/system/developer.md` — Senior Developer implementation constraints and handoff compliance.
* `behavior/system/qa.md` — Independent QA empirical verification and verdict rules.
* `behavior/system/pm.md` — Project Manager inquiry coordination and strict non-interference limits.

`HarnessRegistry` in `src/runtime/harnesses.ts` loads these files with in-memory caching and cascading resolution. Dynamic or custom specialist agents can also be registered at runtime via `HarnessRegistry.registerCustomHarness()`.

##### User Prompt Overrides (Customizing Agent Behavior)

POCLI resolves system prompts using a **cascading priority hierarchy**, allowing users to customize agent directives without modifying the codebase:

1. **User Global Override (`$HOME/.pocli/behavior/system/<role>.md`):** Highest priority. If present, it overrides the default prompt across all projects for your local environment:
   ```bash
   # Example: customize the Senior Developer prompt for your local system
   mkdir -p ~/.pocli/behavior/system
   cp behavior/system/developer.md ~/.pocli/behavior/system/developer.md
   # Edit ~/.pocli/behavior/system/developer.md to inject your custom rules or style guides
   ```
2. **Repository Default (`behavior/system/<role>.md`):** The standard shipped behavior for the team.
3. **In-Memory Fallback:** Built-in embedded definitions ensuring the CLI remains resilient even in isolated or containerized runtimes without filesystem access.

#### 2. Dynamic Context Assembly from SQLite (`src/storage/database.ts`)
On each conversational turn, `src/runtime/orchestrator.ts` calls `storage.assembleAgentContextWindow(projectId, targetRole)`, which queries the central SQLite database (`$HOME/.pocli/pocli.sqlite`):
* **Tier 1 (Authoritative Artifacts):** Queries the `artifacts` table to build a compact normative index (`[ARCH-001 v1 | Status: APPROVED]`).
* **Tier 2 (Memory & Checkpoint):** Reads up to 8 persistent records from the `memories` table (4-layer memory) and the latest structured summary from the `context_compactions` table (produced by `/compact`).
* **Tier 3 (Active Window):** Reads the last 6 uncompacted leaf messages from the `messages` table (Session Tree DAG).

#### 3. Execution Pipeline & Child Process Isolation

In `src/runtime/llm-gateway.ts`, the static harness instructions and dynamic context are merged into a single system instruction block:

```text
${input.systemPrompt}

[NORMATIVE ARTIFACTS]
${input.normativeArtifactsSummary}

[RAG NOTEBOOK SOURCES]
${ragBlock}
```

```
┌──────────────────────────────────────────────┐
│  src/runtime/harnesses.ts                    │ ──> Static Role Prompt (150-250 tokens)
└──────────────────────────────────────────────┘
                       +
┌──────────────────────────────────────────────┐
│  $HOME/.pocli/pocli.sqlite                   │ ──> Tier 1 + Tier 2 (Normative & Compaction)
└──────────────────────────────────────────────┘
                       │
                       ▼  (assembled in src/runtime/orchestrator.ts)
┌──────────────────────────────────────────────┐
│  Linux Child Process Worker (JSON-RPC stdio) │ ──> Sent to LLM Provider (Total: ~600-1,200 tokens)
└──────────────────────────────────────────────┘
```

This multi-process architecture guarantees that agent execution is isolated inside a dedicated Linux child process (`LOCAL_PROCESS`, `LINUX_BWRAP`, or `OCI_CONTAINER`) without blocking the Ink TUI and without leaking conversational state between specialists.

---

## Architecture & Implementation (Phases 0 to 7)

* **Documentation & ADRs:**
  * [agents/AGENTS.md](agents/AGENTS.md) — Master product specification.
  * [agents/IMPLEMENTATION_PLAN.md](agents/IMPLEMENTATION_PLAN.md) — Phased implementation plan.
  * [docs/adr/000-oss-benchmark-matrix.md](docs/adr/000-oss-benchmark-matrix.md) — Open-source reference benchmark matrix (*Slipwright, AWS CAO, Open Orchestra, TinySDLC, Pi, OpenCode*).
  * [docs/adr/001-architecture-and-runtime.md](docs/adr/001-architecture-and-runtime.md) — Modular architecture, `JSON-RPC 2.0` IPC, `node:sqlite` + `FTS5`, RAG Notebooks, and Linux sandboxing.
  * [docs/adr/002-governed-agentic-development.md](docs/adr/002-governed-agentic-development.md) — Governed agentic software development, authority boundary, and non-bypassable human gating.
  * [docs/adr/003-multipanel-worker-and-context-inspector.md](docs/adr/003-multipanel-worker-and-context-inspector.md) — Live Worker Runtime Status & Context/Memory Inspector in Multipanel view.
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
# Launch the interactive fullscreen PO CLI Command Center (Ink TUI)
npm run pocli

# Open the interactive SQLite Database REPL ($HOME/.pocli/pocli.sqlite), just like `opencode db`
npm run pocli -- db

# Print the active SQLite database path or run a one-shot SQL query
npm run pocli -- db path
npm run pocli -- db "SELECT id, name, phase FROM projects;" --format json

# Run the integration test suite (Phases 0 to 7)
npm test

# Build standalone TypeScript executable (`./dist/cli.js` -> `pocli`)
npm run build
```

---

## Interactive TUI Controls & Slash Commands

* Press **`Ctrl+Tab`** at any time to toggle between the **Clean OpenCode View** and the **Multipanel Command Center**.
* Type **`/`** in the prompt input box to open the interactive command menu:
  * `/project` — Interactive wizard (or inline `/project <name> <directory>`) to create a new project in a filesystem directory, initialize `.pocli/artifacts`, automatically discover and register any existing repositories inside that directory, and set it as the active project.
  * `/projects` — List all existing projects in SQLite with their `[ACTIVE]` status, phase, filesystem directory, and discovered repositories, allowing interactive project switching with `↑`/`↓` + `Enter` (or inline `/projects <name-or-id>`).
  * `/architect`, `/developer`, `/qa`, `/pm` — Switch active professional interlocutor (or run parallel/sequential PM inquiries). Architecture design is entirely conversational: discuss goals and constraints with the Architect, and when satisfied, instruct the Architect in chat to transfer the specification to the Developer to begin implementation.
  * `/validate` — Execute independent QA validation tests and collect evidence.
  * `/accept` — Final project acceptance by the Product Owner.
  * `/notebooks` — Re-index and inspect linked RAG Notebooks.
  * `/compact` — Execute **Pi-inspired Context Window Compaction** (`/compact` for the active agent or `/compact all` for all 4 core agents), condensing older conversation turns into a structured SQLite `context_compactions` checkpoint while preserving the full Session Tree (`parent_id` DAG) and cache-friendly 3-tier prompt assembly (`Tier 1: Normative Artifacts` → `Tier 2: 4-Layer Memory & Compaction Checkpoint` → `Tier 3: Active Uncompacted Turns`).
  * `/system` — Open the interactive **System Prompts Inspector** dialog to view the read-only prompt for any specialist (`Architect`, `Developer`, `QA`, `PM`) or inspect `System Prompt Locations` to see active file paths, user overrides (`$HOME/.pocli/behavior/system/`), and in-memory fallbacks.
  * `/db` — Inspect the SQLite database directly inside the TUI (`/db`, `/db .tables`, `/db .experts`, or `/db SELECT ...`), complementing the standalone `pocli db` REPL.
  * `/settings` — Open the interactive Settings modal or configure UI language (`/settings lang en|es`) and the **Central Working & Artifacts Directory** (`/settings dir <path>`, which defaults to `$HOME/.pocli/` and stores all CLI customizations, LLM-generated Python helper scripts in `artifacts/scripts/`, spreadsheets and Project Manager outputs in `artifacts/outputs/`, and mirrored project artifacts).
  * `/howto` — Open the interactive Getting Started and Workflow Guide modal, explaining the Product Owner authority model, the 5-step SDLC process, agent roles, and keyboard shortcuts.
  * `/help` — Display all available commands and keyboard shortcuts.
  * `/view`, `/clear`, `/exit`, `/quit`, `/q`.

---

## Research

POCLI is built on the core engineering philosophy of *"do not reinvent the wheel"*—systematically researching, benchmarking, and synthesizing patterns from state-of-the-art open-source agent frameworks, terminal interfaces, and software engineering methodologies.

### Evaluated Open-Source Reference Repositories

During the initial design and architectural evaluation phase (documented in [ADR-000](docs/adr/000-oss-benchmark-matrix.md)), several leading open-source projects were benchmarked to identify reusable components and foundational patterns:

* **[OpenCode](https://github.com/anomalyco/opencode)** (`anomalyco/opencode`):
  * *Influence:* Benchmark fullscreen terminal UX, clean centered startup view with ASCII art, interactive `/` slash command overlay, darker shaded card backgrounds (`#073642`), vertical accent indicator (`│`), dynamic multi-line expanding prompt input box, right sidebar metadata panel, client/runtime decoupling, and the interactive SQLite REPL (`opencode db` / `pocli db`).
* **[Pi (`pi-mono`)](https://github.com/badlogic/pi-mono)** (`badlogic/pi-mono`):
  * *Influence:* Minimal harness philosophy (concise system prompts of 150–250 tokens per role, sub-second TTFT, avoiding monolithic prompt bloat), lightweight predictable Agent Loop without framework overhead, branching Session Tree DAG (`parent_id`), and structured context compaction checkpointing (`/compact`).
* **[Slipwright](https://github.com/ksksertac/slipwright)** (`ksksertac/slipwright`):
  * *Influence:* Human-in-the-loop gating model, deterministic SDLC state machine with typed schemas, and explicit human approval gates at major milestones (Architecture approval, code delivery handoff).
* **[CLI Agent Orchestrator (CAO)](https://github.com/awslabs/cli-agent-orchestrator)** (`awslabs/cli-agent-orchestrator` by AWS Labs):
  * *Influence:* Multi-agent CLI orchestration patterns, process isolation concepts, role profile management, and task delegation via MCP.
* **[Open Orchestra](https://github.com/0xSero/orchestra)** (`0xSero/orchestra`):
  * *Influence:* Technical specification handoff patterns, strict separation between specification authoring and code execution, and role playbooks.
* **[Open Notebook](https://github.com/lfnovo/open-notebook)** (`lfnovo/open-notebook`):
  * *Influence:* Open-source TypeScript implementation of the NotebookLM paradigm, providing reference architecture for multi-source document ingestion, grounded synthesis, and research workspace management.
* **[TinySDLC](https://github.com/Minh-Tam-Solution/tinysdlc)** (`Minh-Tam-Solution/tinysdlc`):
  * *Influence:* Strict *"No Self-Review"* principle (the Senior Developer never validates their own delivery; the Independent QA Engineer conducts empirical verification with reproducible test cases and execution evidence).

### Foundational Technologies & Runtime Libraries

POCLI leverages battle-tested open-source libraries and native Linux capabilities:

* **[Ink](https://github.com/vadimdemedes/ink)** (`vadimdemedes/ink`): Declarative React-based terminal UI rendering engine, powering the fullscreen Command Center, layout containers, and keyboard event routing.
* **[Yoga Layout](https://github.com/facebook/yoga)** (`facebook/yoga`): Flexbox layout engine powering Ink's terminal box model, dynamic wrapping, and anchored scrollable viewports.
* **[Node.js Native SQLite (`node:sqlite`)](https://nodejs.org/api/sqlite.html)** & **[SQLite FTS5](https://www.sqlite.org/fts5.html)**: Native relational persistence (`DatabaseSync`) in Node.js 24 LTS with write-ahead logging (`WAL`) and BM25 full-text indexing, eliminating external C++ compilation dependencies.
* **[Zod](https://github.com/colinhacks/zod)** (`colinhacks/zod`): TypeScript-first runtime schema validation for IPC messages, domain entities, tool calls, and state transitions.
* **[Bubblewrap (`bwrap`)](https://github.com/containers/bubblewrap)** (`containers/bubblewrap`): Unprivileged Linux namespace sandboxing (`LINUX_BWRAP`) providing mount, PID, network, and IPC isolation with read-only root and workspace-confined writes.
* **[Podman](https://podman.io)**: Rootless OCI container runtime for isolated agent execution (`OCI_CONTAINER`).

### Protocols, Standards & Research Papers

* **[Harness Engineering Research (arXiv:2609.00006)](https://arxiv.org/abs/2609.00006)**: *"Harness Engineering: Anatomy, Architecture, and Evolution of Coding Agents -- A Source-Code Study of Eleven Systems"* (Paul Barbaste, Tristan Darrigol, Germain Vu, Tom Wiltberger, 2026). A cornerstone empirical study defining *harness engineering* as the discipline of designing the runtime that couples an LLM to the world (loop, tools, context management, safety controls, and orchestration). Its findings—demonstrating that production coding agents succeed by eschewing general-purpose agentic frameworks in favor of specialized async loops and deterministic retrieval—serve as the primary theoretical foundation for POCLI's **Minimal Harness Philosophy**, decoupled prompt hierarchy (`behavior/system/`), and low-latency token budgets.
* **[Model Context Protocol (MCP)](https://modelcontextprotocol.io)** (Anthropic): Standardized JSON-RPC 2.0 protocol for secure, extensible tool discovery, external data sources, and role-scoped permissions.
* **[JSON-RPC 2.0 Specification](https://www.jsonrpc.org/specification)**: Lightweight newline-delimited IPC protocol (`NDJSON` over `stdio`) governing parent Orchestrator and child agent worker communication.
* **[NotebookLM](https://notebooklm.google.com)** (Google) & **[Grounded Citation Research (arXiv:2311.09533)](https://arxiv.org/abs/2311.09533)**: Foundational research paper *"Effective Large Language Model Adaptation for Improved Grounding and Citation Generation"* (Google Cloud AI Research, NAACL 2024), establishing the theoretical grounding for Gemini Notebooks. POCLI adapts this methodology for filesystem-backed **Knowledge Notebooks** with hybrid RAG (FTS5 BM25 + vector cosine similarity) and mandatory verifiable source citations (`[Notebook | Document | Section (Lines)]`).
* **[Architectural Decision Records (ADRs)](https://adr.github.io)** (Michael Nygard): Standardized documentation pattern for recording technical decisions and architectural evolution (`ADR-*`).

