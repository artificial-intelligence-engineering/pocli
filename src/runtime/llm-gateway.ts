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
 * Multi-Model LLM Gateway (AGENTS.md Sections 10, 11, 12).
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
            content: `${input.systemPrompt}\n\n[ARTEFACTOS NORMATIVOS]\n${input.normativeArtifactsSummary}\n\n[FUENTES NOTEBOOKS RAG]\n${ragBlock}`,
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
        system: `${input.systemPrompt}\n\n[ARTEFACTOS NORMATIVOS]\n${input.normativeArtifactsSummary}\n\n[FUENTES NOTEBOOKS RAG]\n${ragBlock}`,
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
              text: `${input.systemPrompt}\n\n[ARTEFACTOS NORMATIVOS]\n${input.normativeArtifactsSummary}\n\n[FUENTES NOTEBOOKS RAG]\n${ragBlock}`,
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
        ? `\n\nFuentes consultadas en Notebooks:\n${citationTags.map((t) => `- ${t}`).join('\n')}`
        : '';

    const toolCalls: AgentToolCallRequest[] = [];
    let replyText = '';

    if (input.role === 'architect') {
      const promptLower = input.userPrompt.toLowerCase();
      if (promptLower.includes('arquitectura') || promptLower.includes('diseñ') || promptLower.includes('propon') || promptLower.includes('requisito')) {
        toolCalls.push(
          {
            name: 'propose_requirement',
            arguments: {
              code: 'REQ-001',
              title: `Requisitos Funcionales de ${input.projectName}`,
              content: `# REQ-001: Requisitos Funcionales\n\n- Contexto: ${input.userPrompt}\n- Criterio de aceptación: Procesamiento determinista y validado por pruebas.`,
              citations: citationTags,
            },
          },
          {
            name: 'record_adr',
            arguments: {
              code: 'ADR-001',
              title: 'Arquitectura Modular con Contratos Tipados',
              content: `# ADR-001: Contratos Tipados y Separación de Capas\n\nSe adopta una arquitectura modular con validación de esquemas y persistencia desacoplada.`,
              tracesTo: ['REQ-001'],
              citations: citationTags,
            },
          },
          {
            name: 'write_architecture_doc',
            arguments: {
              code: 'ARCH-001',
              title: `Arquitectura de Referencia — ${input.projectName}`,
              content: `# ARCH-001: Arquitectura Técnica\n\n## Módulos y Contratos\n1. \`domain\`: Entidades y validación.\n2. \`service\`: Lógica de negocio conforme a REQ-001 y ADR-001.\n\n## Restricciones\n- Prohibido acoplar presentación con persistencia.`,
              tracesTo: ['REQ-001', 'ADR-001'],
              citations: citationTags,
            },
          },
          {
            name: 'write_specification',
            arguments: {
              code: 'SPEC-001',
              title: `Especificación Técnica para Desarrollador — ${input.projectName}`,
              content: `# SPEC-001: Especificación de Implementación\n\n- Implementar el módulo principal cumpliendo \`ARCH-001\` y \`REQ-001\`.\n- Exportar funciones puras verificables por QA.`,
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
          `He analizado tus necesidades para **${input.projectName}** y elaborado la propuesta formal:\n` +
          `- \`REQ-001\`: Requisitos funcionales y criterios de aceptación.\n` +
          `- \`ADR-001\`: Decisión arquitectónica sobre contratos y modularidad.\n` +
          `- \`ARCH-001\`: Arquitectura técnica propuesta (en estado \`PENDING_APPROVAL\`).\n` +
          `- \`SPEC-001\`: Especificación técnica detallada para el Desarrollador.\n\n` +
          `Quedo a la espera de tu revisión y **Aprobación Formal** como Product Owner antes de transferir al Desarrollador.${citationFooter}`;
      } else {
        replyText =
          `[Arquitecto de Software] He analizado tu consulta sobre **${input.projectName}** (Fase actual: \`${input.phase}\`). ` +
          `Puedo detallar alternativas arquitectónicas, registrar nuevos ADRs o preparar la propuesta formal \`ARCH-001\` para tu aprobación.${citationFooter}`;
      }
    } else if (input.role === 'developer') {
      const promptLower = input.userPrompt.toLowerCase();
      if (promptLower.includes('ambigüedad') || promptLower.includes('desvi') || promptLower.includes('cambiar arquitectura') || promptLower.includes('bloqueo')) {
        toolCalls.push({
          name: 'consult_architect',
          arguments: {
            subject: 'Consulta sobre restricción arquitectónica detectada en implementación',
            ambiguityOrBlocker: input.userPrompt,
            proposedAlternative: 'Introducir adaptador intermedio manteniendo el contrato de ARCH-001.',
            impactedArtifacts: ['ARCH-001', 'SPEC-001'],
          },
        });
        replyText =
          `[Desarrollador Experto] He detectado una posible desviación o ambigüedad respecto a \`ARCH-001\`. ` +
          `Cumpliendo la regla de autoridad, no modificaré la arquitectura unilateralmente: he enviado una consulta formal (\`consult_architect\`) al Arquitecto.${citationFooter}`;
      } else {
        toolCalls.push(
          {
            name: 'write_implementation_plan',
            arguments: {
              code: 'PLAN-001',
              title: `Plan de Implementación — ${input.projectName}`,
              content: `# PLAN-001: Plan de Implementación\n\nBasado en \`ARCH-001\` y \`SPEC-001\`:\n1. Implementar módulo de dominio.\n2. Preparar verificación para QA.`,
              tracesTo: ['ARCH-001', 'SPEC-001'],
              citations: citationTags,
            },
          },
          {
            name: 'write_source_file',
            arguments: {
              code: 'CODE-001',
              relFilePath: 'src/app-module.js',
              content: `// Generado conforme a ARCH-001 y SPEC-001\nexport function executeBusinessLogic(input) {\n  if (!input || typeof input.value !== 'number') {\n    throw new Error('INVALID_INPUT');\n  }\n  return { ok: true, result: input.value * 2, architectureVersion: 'ARCH-001' };\n}\n`,
              tracesTo: ['REQ-001', 'ARCH-001', 'SPEC-001'],
              citations: citationTags,
            },
          },
        );
        replyText =
          `[Desarrollador Experto] He trabajado sobre el paquete de Handoff aprobado (\`REQ-001\`, \`ARCH-001\`, \`SPEC-001\`) y generado:\n` +
          `- \`PLAN-001\`: Plan de implementación.\n` +
          `- \`CODE-001\` (\`src/app-module.js\`): Implementación alineada con los contratos aprobados.${citationFooter}`;
      }
    } else if (input.role === 'qa') {
      replyText =
        `[Ingeniero de QA] Listo para ejecutar pruebas independientes de validación sobre \`REQ-001\`, \`ARCH-001\` y \`CODE-001\`, recogiendo evidencias reales antes de emitir dictamen (\`ACCEPT\` o \`REJECT\`).${citationFooter}`;
    } else {
      replyText = `[Especialista ${input.role}] Análisis completado para ${input.projectName}.${citationFooter}`;
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

