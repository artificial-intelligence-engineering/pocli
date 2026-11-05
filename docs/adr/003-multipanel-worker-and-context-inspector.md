# ADR-003: Multipanel Worker Runtime and Context/Memory Inspector

**Status:** Approved  
**Date:** 2026-11-05  
**Context:** Design, runtime observability, and metrics breakdown of the live **Worker Runtime & Context/Memory Inspector** within the PO CLI Multipanel Command Center (`viewMode === 'multipanel'`).

---

## 1. Context and Problem Statement

In multi-agent software engineering systems, terminal user interfaces traditionally treat model context, token budgets, and OS process lifecycles as opaque "black boxes":

1. **Context Opacity:** Developers cannot observe whether an agent's context window is approaching model limits, how much memory is active vs. compacted, or what percentage of tokens have been saved by compaction algorithms.
2. **Process Opacity:** Developers cannot determine whether an agent worker is running inside an isolated Linux child process, its OS PID, whether it is currently idle or executing, or how many turns the worker process has handled.
3. **Memory Opacity:** Developers cannot see how persistent 4-layer memory (`CONVERSATIONAL`, `WORKING`, `PROJECT_PERSISTENT`, `AGENT_SPECIFIC`) and normative artifacts are injected into the model prompt across the 3-tier context assembly pipeline.

To provide total observability, **Product Owner CLI (PO CLI)** transforms the primary right-hand container of the **Multipanel Command Center** (`Tab` / `/view`) from a simple message list into a dedicated, live **Worker Runtime & Context/Memory Inspector** for the active specialist.

---

## 2. Multipanel Command Center Layout

The Multipanel Command Center is organized into a dense, high-efficiency dashboard:

```
┌────────────────────────────────────────────────────────────────────────────────────────────────┐
│  ACTIVE PROJECT  │  SOFTWARE ARCHITECT  │  google/gemini-2.5-pro  (Solid Role Theme Banner)    │
├─────────────────────┬─────────────────────┬─────────────────────┬──────────────────────────────┤
│ [PM] Project Mgr    │ ▶ [ARQ] Architect   │ [DEV] Developer     │ [QA] QA Engineer             │
│ (2m · 850t · -240t) │ (8m · 1,420t · -3k) │ (0m · 0t)           │ (0m · 0t)                    │
│ PO: 2 · Arq: 1      │ PO: 6 · Dev: 2      │ PO: 0 · Arq: 0      │ PO: 0 · Dev: 0               │
├─────────────────────┴─────────────────────┴─────────────────────┴──────────────────────────────┤
│ 1. Virtual Team & Artifacts (Left 42%)    │ 📊 WORKER & CONTEXT INSPECTOR (Right 58%)          │
│ • Team list & per-role model assignments  │ 1. Process Worker Runtime Status                   │
│ • Versioned Artifacts (ARCH, SPEC, REQ)   │ 2. Context Window & Compaction Statistics          │
│ • Linked RAG Knowledge Notebooks          │ 3. 4-Layer Persistent Memory & 3-Tier Architecture │
│                                           │ 4. Active Channel Exchange & Runtime Activity      │
├───────────────────────────────────────────┴────────────────────────────────────────────────────┤
│ [Active Project] Software Architect ❯  _                                                       │
│ dir: /workspaces/my-project  ·  ←/→ switch agent  ·  Tab return to clean view                  │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

When switching the active specialist using **left/right arrow carousel navigation** (`←` and `→`), clicking an expert summary card, or using `Ctrl+N`, the Inspector immediately re-binds to that specialist's live Linux process, SQLite memory records, and context window metrics.

---

## 3. Technical Breakdown of Inspector Components & Metrics

The right-hand container displays four structured sections providing exhaustive technical telemetry:

### 3.1. Section 1 — Process Worker Runtime Status

Provides live telemetry on the independent Linux OS process assigned to the selected agent:

| Metric Label | Technical Representation | Definition & Operational Meaning |
| :--- | :--- | :--- |
| **Status** | `● IDLE` (Green)<br>`● BUSY` (Yellow)<br>`✖ FAILED` (Red)<br>`○ STOPPED` (Gray) | The operational lifecycle state of the persistent worker child process. `IDLE` indicates the process is alive and waiting for JSON-RPC 2.0 instructions on `stdin`. `BUSY` indicates active LLM inference or tool execution. `FAILED` indicates unexpected process crash (detected by SQLite recovery). `STOPPED` indicates the worker was terminated or not yet initialized. |
| **PID** | Integer (e.g. `48215`) or `—` | The actual Linux OS Process Identifier (`child_process.pid`) of the persistent child process worker running on the host system. |
| **Modality** | `LOCAL_PROCESS`<br>`LINUX_BWRAP`<br>`OCI_CONTAINER` | The OS-level process sandboxing tier. `LOCAL_PROCESS` runs via unprivileged stdio IPC. `LINUX_BWRAP` runs via Bubblewrap Linux namespaces with a read-only root and workspace-confined writes. `OCI_CONTAINER` runs inside a rootless Podman container. |
| **Turns** | Integer (e.g. `14 turns`) | Total execution turns processed by this persistent worker process since its spawn. Validates persistent worker reuse without per-turn cold-start overhead. |
| **Queued** | `[N en cola]` / `[N queued]` | Number of pending turn requests currently buffered in the agent's FIFO message queue awaiting execution while the worker is busy. |
| **Model** | `vendor/modelId` | The active LLM model identifier assigned to this specialist in SQLite `role_configs` (e.g., `google/gemini-2.5-pro`, `anthropic/claude-3-7-sonnet`, `ollama/qwen2.5-coder`). |

---

### 3.2. Section 2 — Context Window & Compaction Statistics

Exposes the real-time token economics and compaction performance of the active agent:

| Metric Label | Technical Source | Definition & Operational Meaning |
| :--- | :--- | :--- |
| **Context Size** | `activeContextTokens`<br>(e.g. `1,420 tokens`) | The total token estimate currently loaded in the agent's prompt context. Calculated as:$$\text{activeTokens} = \sum_{\text{uncompacted}} \text{token\_estimate} + \text{tokens\_after}(\text{latest\_checkpoint})$$Displays the exact active token payload sent to the LLM inference provider. |
| **Active Turns** | `uncompactedMessages.length` | The count of uncompacted leaf messages from the Session Tree DAG currently present in the active Tier 3 context window. |
| **Total Msgs** | `totalRoleMessages.length` | The cumulative historical count of all conversation turns (both active and compacted) persisted in SQLite for this role. |
| **Compactions** | `compactionCount`<br>(e.g. `2 veces` / `2 times`) | The number of times the `/compact` command has condensed older conversation turns into structured SQLite `context_compactions` checkpoints. |
| **Saved Tokens** | `savedTokensByCompaction`<br>(e.g. `-4,820 tok (68%)`) | The cumulative number of tokens permanently eliminated from recurring system prompts through Pi-inspired compaction:$$\text{savedTokens} = \sum \max(0, \text{tokens\_before} - \text{tokens\_after})$$Includes the token savings percentage relative to uncompacted history. |
| **Latest Checkpoint** | `latestCompactionCheckpoint` | Summary of the most recent compaction event: number of messages condensed, token transition ratio (e.g., `6 msgs (500→150 tok)`), and local execution timestamp. Displays "Within budget (no compactions executed yet)" if context has not required compaction. |

---

### 3.3. Section 3 — 4-Layer Persistent Memory & 3-Tier Architecture

Exposes PO CLI's memory hierarchy and prompt assembly pipeline:

#### 3.3.1. 3-Tier Harness Structure (Pi-Inspired Architecture)
Visualizes how the prompt payload is assembled directly from SQLite in cache-friendly order:
* **`T1 (Normative Prefix)`:** Count of authoritative artifacts (`ARCH-*`, `REQ-*`, `ADR-*`, `SPEC-*`) registered in SQLite and disk. Injected as the immutable, cacheable top prefix that cannot be overridden by agent memory.
* **`T2 (Memory & Checkpoint)`:** Count of persistent 4-layer memories and the structured compaction summary checkpoint.
* **`T3 (Active DAG Window)`:** Number of active uncompacted conversational turns from the Session Tree DAG.

#### 3.3.2. 4-Layer Persistent Memory Breakdown
Shows persistent knowledge records stored in the `memories` table for this agent, broken down by layer:
* **`Conv` (`CONVERSATIONAL`):** Episodic facts, user preferences, and conversational continuity across turns.
* **`Work` (`WORKING`):** Immediate task constraints, scratchpad states, and in-progress deliverable context.
* **`Proj` (`PROJECT_PERSISTENT`):** Repository-wide guidelines, technology stack decisions, and coding standards.
* **`Agent` (`AGENT_SPECIFIC`):** Role-scoped operational directives, specialized rules, and agent behavioral boundaries.

---

### 3.4. Section 4 — Active Channel Exchange & Runtime Activity

Provides immediate visibility into live agent execution:

* **When Busy (`isActiveRoleBusy`):** Displays an animated thinking spinner with queued status:
  `⠋ [Pensando respuesta... · 1 en cola]` / `⠋ [Thinking... · 1 queued]`
* **When Streaming (`activeStreamingText`):** Displays live token generation in real time with an accented heading and cursor:
  `[Architect (streaming)]: analyzing trade-offs between REST and gRPC...█`
* **When Idle:** Displays concise snippets of the last conversational exchange:
  * `PO: <last user prompt snippet>`
  * `<Agent>: <last expert reply snippet>`
* **When Empty:** Displays guidance: `"No conversational activity recorded yet. Type below to converse."`

---

## 4. Consequences and Benefits

1. **Total Runtime Transparency:** Eliminates guesswork regarding process health, token consumption, and memory state.
2. **Deterministic Context Management:** Product Owners can visually verify when context is nearing budget limits and trigger `/compact` with predictable results.
3. **Auditability:** Every metric in the Inspector is backed directly by relational SQLite tables (`messages`, `context_compactions`, `memories`, `role_configs`) and live Linux process telemetry.
