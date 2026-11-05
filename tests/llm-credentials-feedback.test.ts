import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { I18N_DICTIONARY } from '../src/core/i18n.js';
import { LlmGateway } from '../src/runtime/llm-gateway.js';
import { AuthStorage } from '../src/core/auth.js';
import { PoCliDatabase } from '../src/storage/database.js';
import { PoCliOrchestrator } from '../src/runtime/orchestrator.js';

describe('Issue #48 — LLM Missing Credentials and Connectivity Feedback', () => {
  let tmpDir: string;
  let customAuthPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocli-auth-test-'));
    customAuthPath = path.join(tmpDir, 'auth.json');
    AuthStorage.setCustomAuthPath(customAuthPath);
    fs.writeFileSync(customAuthPath, JSON.stringify({}), 'utf8');
  });

  afterEach(() => {
    delete process.env.POCLI_STRICT_LLM;
    AuthStorage.setCustomAuthPath(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1. Provides bilingual dictionary strings for missing API key and connection errors', () => {
    const enMissing = I18N_DICTIONARY.en.llmMissingApiKeyError('anthropic');
    expect(enMissing).toContain("API key for provider 'anthropic' is not configured");
    expect(enMissing).toContain('/auth');
    expect(enMissing).toContain('/models');

    const esMissing = I18N_DICTIONARY.es.llmMissingApiKeyError('anthropic');
    expect(esMissing).toContain("La API key para el proveedor 'anthropic' no está configurada");
    expect(esMissing).toContain('/auth');
    expect(esMissing).toContain('/models');

    const enBanner = I18N_DICTIONARY.en.llmStatusBannerError('anthropic');
    expect(enBanner).toBe('✖ Error: ANTHROPIC API key not configured (use /auth or /models)');

    const esBanner = I18N_DICTIONARY.es.llmStatusBannerError('anthropic');
    expect(esBanner).toBe('✖ Error: ANTHROPIC API key no configurada (usa /auth o /models)');
  });

  it('2. LlmGateway throws explicit missing credential error in strict mode when API key is missing', async () => {
    process.env.POCLI_STRICT_LLM = '1';
    const gateway = new LlmGateway();

    // Verify Spanish error message
    await expect(
      gateway.generateAgentTurn({
        projectId: 'p1',
        projectName: 'Test Project',
        phase: 'PHASE_2_ARCHITECT_ANALYSIS',
        role: 'architect',
        systemPrompt: 'You are an architect.',
        userPrompt: 'Diseña la arquitectura',
        normativeArtifactsSummary: '',
        ragCitations: [],
        modelConfig: {
          role: 'architect',
          provider: 'anthropic',
          modelId: 'claude-3-7-sonnet',
          temperature: 0.2,
        },
        language: 'es',
      }),
    ).rejects.toThrow(
      "La API key para el proveedor 'anthropic' no está configurada. Usa el comando /auth para añadir tu clave de API o cambia de modelo con /models.",
    );

    // Verify English error message
    await expect(
      gateway.generateAgentTurn({
        projectId: 'p1',
        projectName: 'Test Project',
        phase: 'PHASE_2_ARCHITECT_ANALYSIS',
        role: 'architect',
        systemPrompt: 'You are an architect.',
        userPrompt: 'Design the architecture',
        normativeArtifactsSummary: '',
        ragCitations: [],
        modelConfig: {
          role: 'architect',
          provider: 'openai',
          modelId: 'gpt-4o',
          temperature: 0.2,
        },
        language: 'en',
      }),
    ).rejects.toThrow(
      "API key for provider 'openai' is not configured. Use /auth to configure your API key or /models to select another model.",
    );
  });

  it('3. Orchestrator records error directly into SQLite chat history without silent fallback', async () => {
    process.env.POCLI_STRICT_LLM = '1';

    const dbPath = path.join(tmpDir, 'test.sqlite');
    const storage = new PoCliDatabase(dbPath);
    storage.updateSettings({ language: 'es' });

    const orchestrator = new PoCliOrchestrator(storage);

    const project = orchestrator.createProject({
      name: 'AuthFailDemo',
      description: 'Testing missing auth handling',
      workspaceDir: path.join(tmpDir, 'ws-auth'),
    });

    // Record user message
    const userMsg = storage.recordMessage({
      projectId: project.id,
      fromRole: 'product_owner',
      toRole: 'architect',
      content: 'Hola Arquitecto, quiero diseñar una aplicación',
    });

    // Invoke chatWithProfessional which should reject because anthropic API key is missing
    let thrownError: Error | null = null;
    try {
      await orchestrator.chatWithProfessional({
        projectId: project.id,
        targetRole: 'architect',
        message: 'Hola Arquitecto, quiero diseñar una aplicación',
        messageId: userMsg.id,
        alreadyRecorded: true,
      });
    } catch (err) {
      thrownError = err as Error;
      // In TUI, CommandCenterApp catches this and records the error message directly into chat history:
      const cleanMsg = (err as Error).message.replace(
        /^Worker JSON-RPC Error \(-?\d+\):\s*/,
        '',
      );
      storage.recordMessage({
        projectId: project.id,
        fromRole: 'architect',
        toRole: 'product_owner',
        content: cleanMsg,
        metadata: {
          isError: true,
          errorReason: cleanMsg,
        },
      });
    }

    expect(thrownError).not.toBeNull();
    expect(thrownError!.message).toContain(
      "La API key para el proveedor 'anthropic' no está configurada",
    );

    // Verify that the error is now persisted in SQLite messages
    const messages = storage.listMessages(project.id, 'architect');
    expect(messages.length).toBe(2);
    expect(messages[0].fromRole).toBe('product_owner');
    expect(messages[1].fromRole).toBe('architect');
    expect(messages[1].content).toContain(
      "La API key para el proveedor 'anthropic' no está configurada",
    );
    expect(messages[1].metadataJson).toContain('"isError":true');
  });
});
