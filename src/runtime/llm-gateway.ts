import {
  ActorRole,
  RagCitation,
  RoleModelConfig,
  WorkflowPhase,
} from '../core/contracts.js';
import { NotebookRagEngine } from './notebook-rag.js';

export interface AgentToolCallRequest {
  name: string;
  arguments: Record<string, unknown>;
}

export interface AgentTurnInput {
  projectId: string;
  projectName: string;
  phase: WorkflowPhase;
  role: ActorRole;
  systemPrompt: string;
  userPrompt: string;
  normativeArtifactsSummary: string;
  ragCitations: RagCitation[];
  modelConfig: RoleModelConfig;
}

export interface AgentTurnOutput {
  replyText: string;
  toolCalls: AgentToolCallRequest[];
  providerUsed: string;
  modelUsed: string;
}

/**
 * Multi-Model LLM Gateway.
 * Decouples workflow execution from specific LLM providers and allows different
 * models for Architect, Developer, QA, and custom specialists.
 */
export class LlmGateway {
  async generateAgentTurn(
    input: AgentTurnInput,
    onStreamToken?: (chunk: string) => void,
  ): Promise<AgentTurnOutput> {
    const { provider, modelId, temperature } = input.modelConfig;

    if (provider === 'openai' && process.env.OPENAI_API_KEY) {
      return this.callOpenAiCompatible(
        'https://api.openai.com/v1/chat/completions',
        process.env.OPENAI_API_KEY,
        modelId,
        temperature,
        input,
        onStreamToken,
      );
    }

    if (provider === 'ollama') {
      const baseUrl = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
      return this.callOpenAiCompatible(
        `${baseUrl}/v1/chat/completions`,
        'ollama',
        modelId,
        temperature,
        input,
        onStreamToken,
      );
    }

    if (provider === 'anthropic' && process.env.ANTHROPIC_API_KEY) {
      return this.callAnthropic(
        process.env.ANTHROPIC_API_KEY,
        modelId,
        temperature,
        input,
        onStreamToken,
      );
    }

    if (provider === 'gemini' && process.env.GEMINI_API_KEY) {
      return this.callGemini(
        process.env.GEMINI_API_KEY,
        modelId,
        temperature,
        input,
        onStreamToken,
      );
    }

    // Deterministic specialist engine (default for local verification & zero-key operation)
    return this.runDeterministicSpecialist(input, onStreamToken);
  }

  private async callOpenAiCompatible(
    endpoint: string,
    apiKey: string,
    modelId: string,
    temperature: number,
    input: AgentTurnInput,
    onStreamToken?: (chunk: string) => void,
  ): Promise<AgentTurnOutput> {
    const ragBlock = input.ragCitations
      .map(
        (c) =>
          `${NotebookRagEngine.formatCitationTag(c)}\n${c.snippet}`,
      )
      .join('\n\n');

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelId,
        temperature,
        messages: [
          {
            role: 'system',
            content: `${input.systemPrompt}\n\n[NORMATIVE ARTIFACTS]\n${input.normativeArtifactsSummary}\n\n[RAG NOTEBOOK SOURCES]\n${ragBlock}`,
          },
          { role: 'user', content: input.userPrompt },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`LLM Provider HTTP ${response.status}: ${await response.text()}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const replyText = data.choices?.[0]?.message?.content ?? '';
    if (onStreamToken && replyText) onStreamToken(replyText);

    return {
      replyText,
      toolCalls: [],
      providerUsed: input.modelConfig.provider,
      modelUsed: modelId,
    };
  }

  private async callAnthropic(
    apiKey: string,
    modelId: string,
    temperature: number,
    input: AgentTurnInput,
    onStreamToken?: (chunk: string) => void,
  ): Promise<AgentTurnOutput> {
    const ragBlock = input.ragCitations
      .map((c) => `${NotebookRagEngine.formatCitationTag(c)}\n${c.snippet}`)
      .join('\n\n');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: 2048,
        temperature,
        system: `${input.systemPrompt}\n\n[NORMATIVE ARTIFACTS]\n${input.normativeArtifactsSummary}\n\n[RAG NOTEBOOK SOURCES]\n${ragBlock}`,
        messages: [{ role: 'user', content: input.userPrompt }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Anthropic HTTP ${response.status}: ${await response.text()}`);
    }

    const data = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const replyText =
      data.content?.filter((b) => b.type === 'text').map((b) => b.text).join('\n') ?? '';
    if (onStreamToken && replyText) onStreamToken(replyText);

    return {
      replyText,
      toolCalls: [],
      providerUsed: 'anthropic',
      modelUsed: modelId,
    };
  }

  private async callGemini(
    apiKey: string,
    modelId: string,
    temperature: number,
    input: AgentTurnInput,
    onStreamToken?: (chunk: string) => void,
  ): Promise<AgentTurnOutput> {
    const ragBlock = input.ragCitations
      .map((c) => `${NotebookRagEngine.formatCitationTag(c)}\n${c.snippet}`)
      .join('\n\n');

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text: `${input.systemPrompt}\n\n[NORMATIVE ARTIFACTS]\n${input.normativeArtifactsSummary}\n\n[RAG NOTEBOOK SOURCES]\n${ragBlock}`,
            },
          ],
        },
        contents: [{ role: 'user', parts: [{ text: input.userPrompt }] }],
        generationConfig: { temperature },
      }),
    });

    if (!response.ok) {
      throw new Error(`Gemini HTTP ${response.status}: ${await response.text()}`);
    }

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const replyText =
      data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('\n') ?? '';
    if (onStreamToken && replyText) onStreamToken(replyText);

    return {
      replyText,
      toolCalls: [],
      providerUsed: 'gemini',
      modelUsed: modelId,
    };
  }

  private async runDeterministicSpecialist(
    input: AgentTurnInput,
    onStreamToken?: (chunk: string) => void,
  ): Promise<AgentTurnOutput> {
    const citationTags = input.ragCitations.map((c) =>
      NotebookRagEngine.formatCitationTag(c),
    );
    const citationFooter =
      citationTags.length > 0
        ? `\n\nSources consulted in Notebooks:\n${citationTags.map((t) => `- ${t}`).join('\n')}`
        : '';

    const toolCalls: AgentToolCallRequest[] = [];
    let replyText = '';

    if (input.role === 'architect') {
      const promptLower = input.userPrompt.toLowerCase();
      if (
        promptLower.includes('architecture') ||
        promptLower.includes('design') ||
        promptLower.includes('propose') ||
        promptLower.includes('requirement') ||
        promptLower.includes('arquitectura') ||
        promptLower.includes('diseñ') ||
        promptLower.includes('propon') ||
        promptLower.includes('requisito')
      ) {
        toolCalls.push(
          {
            name: 'propose_requirement',
            arguments: {
              code: 'REQ-001',
              title: `Functional Requirements — ${input.projectName}`,
              content: `# REQ-001: Functional Requirements\n\n- Context: ${input.userPrompt}\n- Acceptance criterion: Deterministic processing verified by automated QA tests.`,
              citations: citationTags,
            },
          },
          {
            name: 'record_adr',
            arguments: {
              code: 'ADR-001',
              title: 'Modular Architecture with Typed Contracts',
              content: `# ADR-001: Typed Contracts and Layer Separation\n\nAdopts a modular architecture with schema validation and decoupled persistence.`,
              tracesTo: ['REQ-001'],
              citations: citationTags,
            },
          },
          {
            name: 'write_architecture_doc',
            arguments: {
              code: 'ARCH-001',
              title: `Reference Architecture — ${input.projectName}`,
              content: `# ARCH-001: Technical Architecture\n\n## Modules and Contracts\n1. \`domain\`: Core entities and validation.\n2. \`service\`: Business logic compliant with REQ-001 and ADR-001.\n\n## Constraints\n- Presentation and persistence layers must remain strictly decoupled.`,
              tracesTo: ['REQ-001', 'ADR-001'],
              citations: citationTags,
            },
          },
          {
            name: 'write_specification',
            arguments: {
              code: 'SPEC-001',
              title: `Developer Technical Specification — ${input.projectName}`,
              content: `# SPEC-001: Implementation Specification\n\n- Implement the primary module fulfilling \`ARCH-001\` and \`REQ-001\`.\n- Export pure functions verifiable by independent QA.`,
              tracesTo: ['REQ-001', 'ARCH-001'],
              citations: citationTags,
            },
          },
          {
            name: 'request_po_approval',
            arguments: {
              artifactCode: 'ARCH-001',
            },
          },
        );
        replyText =
          `I have analyzed the requirements for **${input.projectName}** and prepared the formal proposal:\n` +
          `- \`REQ-001\`: Functional requirements and acceptance criteria.\n` +
          `- \`ADR-001\`: Architectural decision record on contracts and modularity.\n` +
          `- \`ARCH-001\`: Proposed technical architecture (status \`PENDING_APPROVAL\`).\n` +
          `- \`SPEC-001\`: Detailed technical specification for the Developer.\n\n` +
          `Awaiting your review and **Formal Approval** as Product Owner before handoff to the Developer.${citationFooter}`;
      } else {
        replyText =
          `[Software Architect] I have analyzed your inquiry regarding **${input.projectName}** (Current phase: \`${input.phase}\`). ` +
          `I can evaluate architectural alternatives, record new ADRs, or prepare the formal \`ARCH-001\` proposal for your approval.${citationFooter}`;
      }
    } else if (input.role === 'developer') {
      const promptLower = input.userPrompt.toLowerCase();
      if (
        promptLower.includes('ambiguity') ||
        promptLower.includes('deviat') ||
        promptLower.includes('blocker') ||
        promptLower.includes('ambigüedad') ||
        promptLower.includes('desvi') ||
        promptLower.includes('bloqueo')
      ) {
        toolCalls.push({
          name: 'consult_architect',
          arguments: {
            subject: 'Consultation regarding architectural constraint during implementation',
            ambiguityOrBlocker: input.userPrompt,
            proposedAlternative: 'Introduce an intermediate adapter while preserving the ARCH-001 contract.',
            impactedArtifacts: ['ARCH-001', 'SPEC-001'],
          },
        });
        replyText =
          `[Senior Developer] I detected a potential deviation or ambiguity regarding \`ARCH-001\`. ` +
          `Following the authority rule, I will not modify the architecture unilaterally: I have submitted a formal consultation (\`consult_architect\`) to the Software Architect.${citationFooter}`;
      } else {
        toolCalls.push(
          {
            name: 'write_implementation_plan',
            arguments: {
              code: 'PLAN-001',
              title: `Implementation Plan — ${input.projectName}`,
              content: `# PLAN-001: Implementation Plan\n\nBased on \`ARCH-001\` and \`SPEC-001\`:\n1. Implement core domain module.\n2. Prepare verification deliverable for QA.`,
              tracesTo: ['ARCH-001', 'SPEC-001'],
              citations: citationTags,
            },
          },
          {
            name: 'write_source_file',
            arguments: {
              code: 'CODE-001',
              relFilePath: 'src/app-module.js',
              content: `// Generated in compliance with ARCH-001 and SPEC-001\nexport function executeBusinessLogic(input) {\n  if (!input || typeof input.value !== 'number') {\n    throw new Error('INVALID_INPUT');\n  }\n  return { ok: true, result: input.value * 2, architectureVersion: 'ARCH-001' };\n}\n`,
              tracesTo: ['REQ-001', 'ARCH-001', 'SPEC-001'],
              citations: citationTags,
            },
          },
        );
        replyText =
          `[Senior Developer] Worked on the approved Handoff bundle (\`REQ-001\`, \`ARCH-001\`, \`SPEC-001\`) and produced:\n` +
          `- \`PLAN-001\`: Implementation plan.\n` +
          `- \`CODE-001\` (\`src/app-module.js\`): Source implementation aligned with approved contracts.${citationFooter}`;
      }
    } else if (input.role === 'qa') {
      replyText =
        `[Independent QA Engineer] Ready to execute independent validation tests against \`REQ-001\`, \`ARCH-001\`, and \`CODE-001\`, collecting real execution evidence before issuing a verdict (\`ACCEPT\` or \`REJECT\`).${citationFooter}`;
    } else {
      replyText = `[Specialist ${input.role}] Analysis completed for ${input.projectName}.${citationFooter}`;
    }

    if (onStreamToken && replyText) {
      const words = replyText.split(' ');
      for (const word of words) {
        onStreamToken(`${word} `);
      }
    }

    return {
      replyText,
      toolCalls,
      providerUsed: input.modelConfig.provider,
      modelUsed: input.modelConfig.modelId,
    };
  }
}
