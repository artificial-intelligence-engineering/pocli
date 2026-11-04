# ADR-002: Governed Agentic Development: SDD and ODD Hybrid Methodology

**Status:** Approved  
**Date:** 2026-11-04  
**Context:** Reconciliation of Spec-Driven Development (SDD) and Organic-Driven Development (ODD) within the multi-agent virtual engineering team of **Product Owner CLI (PO CLI)**, aligning with industry guidance from Anthropic and OpenAI.

---

## 1. Context and Problem Statement

When applying autonomous and semi-autonomous AI agents to software engineering, two contrasting development philosophies emerge:

1. **Spec-Driven Development (SDD):**
   * *Principles:* Normative specifications precede source code; strict bidirectional traceability; formal handoffs between specialists; independent QA validation.
   * *Strengths:* Auditability, elimination of hallucinations, reproducible requirements, and deterministic state transitions.
   * *Risks:* Bureaucracy and paralysis when attempting to exhaustively specify complex systems, legacy codebases, or unfamiliar third-party libraries before understanding domain realities.

2. **Organic-Driven Development (ODD):**
   * *Principles:* Exploratory, hypothesis-driven, and empirical investigation; direct inspection of runtime behavior, legacy repositories, and environment traces.
   * *Strengths:* Rapid comprehension of legacy code, active diagnostics, and empirically grounded solutions.
   * *Risks:* Architectural drift, lack of auditability, spaghetti patches, and unconstrained agent hallucinations when checkpoints and contracts are absent.

Rather than forcing a false dichotomy, PO CLI treats **SDD and ODD as complementary lifecycle phases** under the ultimate authority of the human **Product Owner (PO)**.

---

## 2. Decision: Governed Agentic Development

We formally adopt **Governed Agentic Development** as PO CLI's canonical methodology. The lifecycle structures the interplay between empirical exploration (ODD) and contractual rigor (SDD) across five disciplined stages:

```
  [ DISCOVER (ODD) ] ────► [ PROMOTE (Bridge) ] ────► [ SPECIFY & APPROVE (SDD) ]
   • Sandboxed spikes       • /promote EXP-001          • ADR-*, SPEC-*, ARCH-*
   • EXP-* & OBS-*          • Bidirectional traces      • Human PO Authority
                                                                │
                                                                ▼
  [ CONSOLIDATE ] ◄────── [ VERIFY (QA) ] ◄────────── [ BUILD (SDD + TDD) ]
   • PM Report             • Independent check         • Developer implementation
   • State consolidation   • Evidence-based DEF-*      • Bound strictly to specs
```

### 2.1. Stage 1 — DISCOVER (ODD / Context-Driven)
* Agents (`Architect` or `Developer`) investigate domain constraints, legacy code, or library capabilities through empirical hypotheses and bounded sandbox executions (`LOCAL_PROCESS`, `LINUX_BWRAP`, or `OCI_CONTAINER`).
* Exploratory work is strictly documented using structured ODD artifacts:
  * **`EXP-*` (Experiment):** Captures the explicit hypothesis, sandboxed execution steps, raw command outputs, findings, and governance verdict.
  * **`OBS-*` (Observation):** Captures empirical findings from inspecting legacy source trees, configuration files, or external services.
* **Invariant:** Exploratory spikes and discarded hypotheses never directly modify production code branches or pollute approved architecture.

### 2.2. Stage 2 — PROMOTE (Governance Bridge)
* Validated experiments are evaluated against a typed verdict:
  * `DISCARD`: Hypothesis disproven or abandoned; preserved in the SQLite ledger as lessons learned without impacting architecture.
  * `PROMOTE_TO_ADR`: Discovery carries systemic design impact; triggers promotion to an Architectural Decision Record (`ADR-*`).
  * `PROMOTE_TO_SPEC`: Discovery defines an implementation detail or interface; triggers promotion to a Technical Specification (`SPEC-*`).
  * `NEEDS_FURTHER_EXPERIMENTATION`: Discovery is inconclusive; requires follow-up spikes.
* Promotion establishes formal bidirectional traceability: the resulting contract includes `tracesTo: ['EXP-001']`, and the experiment records `promotedTo: { artifactCode: 'ADR-002', promotedAt: '...' }`.

### 2.3. Stage 3 — SPECIFY & APPROVE (SDD / Contract-Driven)
* The `Architect` formalizes the promoted findings into normative artifacts (`ARCH-*`, `ADR-*`, `SPEC-*`).
* The human Product Owner retains sovereign decision authority: no promoted architecture or ADR transitions to `APPROVED` without explicit Product Owner action (`/approve`).

### 2.4. Stage 4 — BUILD (SDD + TDD)
* The `Developer` receives the formal handoff and implements source code (`CODE-*`) conforming strictly to the approved specification.
* The Developer is prohibited from altering architecture unilaterally. Unforeseen impediments trigger `consult_architect`.

### 2.5. Stage 5 — ACCEPT & VERIFY (Generator-Verifier / Evidence-Driven QA)
* In alignment with the *Evaluator-Optimizer* and *Generator-Verifier* patterns, the `QA` engineer verifies deliverables independently.
* QA conducts empirical test runs collecting stdout/stderr evidence, logs defects (`DEF-*`) classified by severity, and recommends `ACCEPT` or `REJECT`.
* Final delivery acceptance remains the exclusive prerogative of the human Product Owner (`/accept`).

---

## 3. Data Model and Typed Contracts

The methodology is enforced at runtime via `Zod` schemas in `src/core/contracts.ts`:

1. **`ArtifactTypeSchema`:** Extended with `'EXPERIMENT'` (`EXP-*`) and `'OBSERVATION'` (`OBS-*`).
2. **`ExperimentVerdictSchema`:** Strongly typed governance outcomes:
   * `'DISCARD'`
   * `'PROMOTE_TO_ADR'`
   * `'PROMOTE_TO_SPEC'`
   * `'NEEDS_FURTHER_EXPERIMENTATION'`
3. **`ExperimentExecutionStepSchema`:** Deterministic record of spiked commands, snippets, exit codes, and durations.
4. **`ExperimentArtifactPayloadSchema`:** Enforces `hypothesis`, `context`, `steps`, `findings`, `verdict`, `justification`, and optional `promotedTo` link.
5. **`ObservationArtifactPayloadSchema`:** Enforces `targetEntity`, `environment`, `summary`, `findings`, and `potentialRisks`.

---

## 4. Alignment with Industry Standards

* **Anthropic (*Building Effective Agents*):** POCLI employs deterministic orchestrator-workers and generator-verifier state machines rather than opaque autonomous agent frameworks.
* **OpenAI (*Agents SDK & Control Plane*):** Explicit human-in-the-loop checkpoints, typed handoffs between specialized roles, and strict execution guardrails.
* **Harness Engineering (*arXiv:2609.00006*):** Role harnesses constrain tool accessibility, enforce normative context assembly, and prevent unbounded agent drift.

---

## 5. Consequences and Trade-Offs

### Positive
* **Zero Hallucinated Invariants:** Architecture reflects verified realities established in sandboxed experiments rather than LLM assumptions.
* **Clean Codebases:** Discarded spikes and failed prototypes remain isolated in `EXP-*` ledgers, preventing speculative dead code from entering the repository.
* **Full Auditability:** Every architectural decision (`ADR-*`) and specification (`SPEC-*`) links directly to the empirical proof (`EXP-*`) that justified it.

### Trade-Offs
* Requires agents to formulate explicit hypotheses and steps rather than silently attempting arbitrary code mutations.
