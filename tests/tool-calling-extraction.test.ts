import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { extractToolCalls } from '../src/runtime/llm-gateway.js';
import { buildRoleToolsInstruction } from '../src/runtime/harnesses.js';
import { PoCliDatabase } from '../src/storage/database.js';
import { PoCliOrchestrator } from '../src/runtime/orchestrator.js';

describe('Issue #54 — Tool Calling & Filesystem Single Source of Truth', () => {
  describe('extractToolCalls', () => {
    it('returns empty toolCalls and original text when no tool blocks exist', () => {
      const text = 'Hello Product Owner, I have analyzed your system requirements.';
      const res = extractToolCalls(text);
      expect(res.cleanText).toBe(text);
      expect(res.toolCalls).toHaveLength(0);
    });

    it('extracts single ```tool_call block and cleans the output text', () => {
      const raw = [
        'I have prepared the specification for the new application.',
        '```tool_call',
        '{',
        '  "name": "write_specification",',
        '  "arguments": {',
        '    "code": "SPEC-001",',
        '    "title": "Developer Specification",',
        '    "content": "# SPEC-001: Developer Spec\\n\\nStack: Python 3.11+, FastAPI"',
        '  }',
        '}',
        '```',
        'Please review and approve before handoff.',
      ].join('\n');

      const res = extractToolCalls(raw);
      expect(res.toolCalls).toHaveLength(1);
      expect(res.toolCalls[0].name).toBe('write_specification');
      expect(res.toolCalls[0].arguments.code).toBe('SPEC-001');
      expect(res.toolCalls[0].arguments.title).toBe('Developer Specification');
      expect(res.cleanText).toContain('I have prepared the specification');
      expect(res.cleanText).toContain('Please review and approve before handoff.');
      expect(res.cleanText).not.toContain('```tool_call');
      expect(res.cleanText).not.toContain('"write_specification"');
    });

    it('extracts multiple consecutive tool calls from separate blocks', () => {
      const raw = [
        'Formal architecture and ADR proposal ready:',
        '```tool_call',
        '{"name": "record_adr", "arguments": {"code": "ADR-001", "title": "3-Tier Architecture"}}',
        '```',
        '```tool_call',
        '{"name": "write_specification", "arguments": {"code": "SPEC-001", "title": "Technical Specification"}}',
        '```',
        '```tool_call',
        '{"name": "request_po_approval", "arguments": {"artifactCode": "ARCH-001"}}',
        '```',
        'Awaiting your authorization.',
      ].join('\n');

      const res = extractToolCalls(raw);
      expect(res.toolCalls).toHaveLength(3);
      expect(res.toolCalls[0].name).toBe('record_adr');
      expect(res.toolCalls[1].name).toBe('write_specification');
      expect(res.toolCalls[2].name).toBe('request_po_approval');
      expect(res.cleanText).toBe('Formal architecture and ADR proposal ready:\n\nAwaiting your authorization.');
    });

    it('handles JSON array inside single tool_call block', () => {
      const raw = [
        '```tool_call',
        '[',
        '  {"name": "record_adr", "arguments": {"code": "ADR-001"}},',
        '  {"name": "write_specification", "arguments": {"code": "SPEC-001"}}',
        ']',
        '```',
        'Done.',
      ].join('\n');

      const res = extractToolCalls(raw);
      expect(res.toolCalls).toHaveLength(2);
      expect(res.toolCalls[0].name).toBe('record_adr');
      expect(res.toolCalls[1].name).toBe('write_specification');
      expect(res.cleanText).toBe('Done.');
    });

    it('accepts tool/params aliases and stringified JSON arguments', () => {
      const raw = [
        '```tool_call',
        '{"tool": "write_source_file", "params": "{\\"relFilePath\\": \\"app/main.py\\", \\"content\\": \\"print(1)\\"}"}',
        '```',
      ].join('\n');

      const res = extractToolCalls(raw);
      expect(res.toolCalls).toHaveLength(1);
      expect(res.toolCalls[0].name).toBe('write_source_file');
      expect(res.toolCalls[0].arguments.relFilePath).toBe('app/main.py');
    });

    it('robustly extracts tool calls containing nested markdown code blocks and ASCII diagrams without truncation', () => {
      const raw = [
        'I have designed the system architecture.',
        '```tool_call',
        '{',
        '  "name": "write_architecture_doc",',
        '  "arguments": {',
        '    "code": "ARCH-001",',
        '    "title": "Technical Architecture",',
        '    "content": "# ARCH-001\\n\\n```\\n+-----+      HTTP      +-----+\\n| CLI | -------------> | API |\\n+-----+ <------------- +-----+\\n```\\n\\n## Details\\nModular structure.",',
        '    "tracesTo": ["REQ-001", "ADR-001"]',
        '  }',
        '}',
        '```',
        '```tool_call',
        '{',
        '  "name": "write_specification",',
        '  "arguments": {',
        '    "code": "SPEC-001",',
        '    "title": "Technical Specification",',
        '    "content": "# SPEC-001\\n\\n```json\\n{\\"status\\": \\"ok\\"}\\n```"',
        '  }',
        '}',
        '```',
        'Please review and authorize.',
      ].join('\n');

      const res = extractToolCalls(raw);
      expect(res.toolCalls).toHaveLength(2);
      expect(res.toolCalls[0].name).toBe('write_architecture_doc');
      expect(res.toolCalls[0].arguments.code).toBe('ARCH-001');
      expect(res.toolCalls[0].arguments.content).toContain('+-----+      HTTP      +-----+');
      expect(res.toolCalls[0].arguments.content).toContain('Modular structure.');
      expect(res.toolCalls[0].arguments.tracesTo).toEqual(['REQ-001', 'ADR-001']);

      expect(res.toolCalls[1].name).toBe('write_specification');
      expect(res.toolCalls[1].arguments.code).toBe('SPEC-001');
      expect(res.toolCalls[1].arguments.content).toContain('{"status": "ok"}');

      expect(res.cleanText).toBe('I have designed the system architecture.\n\nPlease review and authorize.');
      expect(res.cleanText).not.toContain('```tool_call');
      expect(res.cleanText).not.toContain('ARCH-001');
    });

    it('extracts raw inline tool JSON objects without code fences', () => {
      const raw = [
        'Here is the requirement proposal:',
        '{"name": "propose_requirement", "arguments": {"code": "REQ-001", "title": "User Authentication"}}',
        'Let me know your feedback.',
      ].join('\n');

      const res = extractToolCalls(raw);
      expect(res.toolCalls).toHaveLength(1);
      expect(res.toolCalls[0].name).toBe('propose_requirement');
      expect(res.toolCalls[0].arguments.code).toBe('REQ-001');
      expect(res.cleanText).toBe('Here is the requirement proposal:\n\nLet me know your feedback.');
    });

    it('buildRoleToolsInstruction provides actionable tool instructions for architect, developer, qa', () => {
      const archPrompt = buildRoleToolsInstruction('architect');
      expect(archPrompt).toContain('write_specification');
      expect(archPrompt).toContain('write_architecture_doc');
      expect(archPrompt).toContain('```tool_call');

      const devPrompt = buildRoleToolsInstruction('developer');
      expect(devPrompt).toContain('write_source_file');
      expect(devPrompt).toContain('write_implementation_log');
      expect(devPrompt).toContain('consult_architect');
      expect(devPrompt).toContain('```tool_call');

      const qaPrompt = buildRoleToolsInstruction('qa');
      expect(qaPrompt).toContain('write_test_case');
      expect(qaPrompt).toContain('submit_qa_report');
    });
  });

  describe('Filesystem as Single Source of Truth for Artifacts', () => {
    let tmpDir: string;
    let storage: PoCliDatabase;
    let projectId: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocli-ssot-test-'));
      storage = new PoCliDatabase(path.join(tmpDir, 'test.sqlite'));
      const project = storage.createProject({
        name: 'SSOT-Demo-Project',
        description: 'Test project for SSOT',
        workspaceDir: path.join(tmpDir, 'workspace'),
      });
      projectId = project.id;
    });

    afterEach(() => {
      storage.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('writes markdown files directly to disk in contracts/', () => {
      const art = storage.saveArtifact({
        projectId,
        code: 'SPEC-001',
        type: 'SPECIFICATION',
        title: 'FastAPI Specification',
        content: '# SPEC-001: FastAPI Specification\n\nEndpoints:\n- GET /health\n- GET /products',
        authorRole: 'architect',
      });

      expect(fs.existsSync(art.filePath)).toBe(true);
      expect(art.filePath).toContain(path.join('contracts', 'specification', 'SPEC-001_v1.md'));

      const diskContent = fs.readFileSync(art.filePath, 'utf8');
      expect(diskContent).toContain('# SPEC-001: FastAPI Specification');
      expect(diskContent).toContain('GET /products');
    });

    it('reflects manual external disk edits immediately via mapArtifactRow without SQLite write', () => {
      const art = storage.saveArtifact({
        projectId,
        code: 'ADR-001',
        type: 'ADR',
        title: 'Database Engine Selection',
        content: '# ADR-001: Initial Content SQLite',
        authorRole: 'architect',
      });

      // Simulate human developer modifying the markdown file in an external editor / Git
      const updatedMarkdown = '# ADR-001: Modified by Developer\n\nAdopting PostgreSQL instead of SQLite.';
      fs.writeFileSync(art.filePath, updatedMarkdown, 'utf8');

      // Query artifact from SQLite
      const reloaded = storage.getArtifactById(art.id);
      expect(reloaded).not.toBeNull();
      // Content is read live from disk: Single Source of Truth!
      expect(reloaded!.content).toBe(updatedMarkdown);

      const latestByCode = storage.getLatestArtifactByCode(projectId, 'ADR-001');
      expect(latestByCode!.content).toBe(updatedMarkdown);

      const listed = storage.listArtifacts(projectId, true);
      const found = listed.find((a) => a.code === 'ADR-001');
      expect(found!.content).toBe(updatedMarkdown);
    });

    it('includes full normative artifact contents loaded from disk in assembleAgentContextWindow', () => {
      storage.saveArtifact({
        projectId,
        code: 'ADR-001',
        type: 'ADR',
        title: 'Layer Separation',
        content: '# ADR-001: Layer Separation\nDecouple routes from db.',
        authorRole: 'architect',
      });

      storage.saveArtifact({
        projectId,
        code: 'SPEC-001',
        type: 'SPECIFICATION',
        title: 'Developer Spec',
        content: '# SPEC-001: Developer Spec\nCreate app/core, app/models, app/api.',
        authorRole: 'architect',
      });

      const contextWindow = storage.assembleAgentContextWindow(projectId, 'developer');

      expect(contextWindow.formattedPromptContext).toContain('[TIER 1 — CACHEABLE NORMATIVE ARTIFACTS');
      expect(contextWindow.formattedPromptContext).toContain('SPEC-001 v1 | SPECIFICATION');
      expect(contextWindow.formattedPromptContext).toContain('# SPEC-001: Developer Spec');
      expect(contextWindow.formattedPromptContext).toContain('Create app/core, app/models, app/api.');
      expect(contextWindow.formattedPromptContext).toContain('ADR-001 v1 | ADR');
      expect(contextWindow.formattedPromptContext).toContain('Decouple routes from db.');
    });

    it('end-to-end: tool calling persists physical markdown contracts and loads them into developer context', async () => {
      // Simulate an agent turn output that emitted tool calls
      const adrContent = '# ADR-001: FastAPI Architecture\n\nModular 3-layer pattern.';
      const specContent = '# SPEC-001: Technical Specification\n\nStack: Python 3.11+, FastAPI, SQLAlchemy, SQLite.\nDirectories:\n- app/core\n- app/models\n- app/api';

      // 1. Emulate tool calls received from LLMGateway
      const toolCalls = [
        {
          name: 'record_adr',
          arguments: {
            code: 'ADR-001',
            title: 'FastAPI Architecture',
            content: adrContent,
          },
        },
        {
          name: 'write_specification',
          arguments: {
            code: 'SPEC-001',
            title: 'Technical Specification',
            content: specContent,
          },
        },
        {
          name: 'request_po_approval',
          arguments: {
            artifactCode: 'ARCH-001',
          },
        },
      ];

      // 2. Save artifacts via storage (same logic as executeAgentToolCalls)
      for (const call of toolCalls) {
        if (call.name === 'record_adr') {
          storage.saveArtifact({
            projectId,
            role: 'architect',
            code: call.arguments.code,
            type: 'ADR',
            title: call.arguments.title,
            content: call.arguments.content,
            authorRole: 'architect',
          });
        } else if (call.name === 'write_specification') {
          storage.saveArtifact({
            projectId,
            role: 'architect',
            code: call.arguments.code,
            type: 'SPECIFICATION',
            title: call.arguments.title,
            content: call.arguments.content,
            authorRole: 'architect',
          });
        }
      }

      // 3. Verify physical files exist on the filesystem
      const project = storage.getProject(projectId)!;
      const adrPath = path.join(
        project.workspaceDir,
        'contracts',
        'adr',
        'ADR-001_v1.md',
      );
      const specPath = path.join(
        project.workspaceDir,
        'contracts',
        'specification',
        'SPEC-001_v1.md',
      );

      expect(fs.existsSync(adrPath)).toBe(true);
      expect(fs.readFileSync(adrPath, 'utf8')).toBe(adrContent);

      expect(fs.existsSync(specPath)).toBe(true);
      expect(fs.readFileSync(specPath, 'utf8')).toBe(specContent);

      // 4. Verify developer context assembly loads both files directly from disk
      const devContext = storage.assembleAgentContextWindow(projectId, 'developer');
      expect(devContext.formattedPromptContext).toContain('ADR-001 v1 | ADR');
      expect(devContext.formattedPromptContext).toContain('Modular 3-layer pattern.');
      expect(devContext.formattedPromptContext).toContain('SPEC-001 v1 | SPECIFICATION');
      expect(devContext.formattedPromptContext).toContain('app/core');
      expect(devContext.formattedPromptContext).toContain('app/models');
      expect(devContext.formattedPromptContext).toContain('app/api');
    });

    it('creates architecture directory and ARCH-001_v1.md when tool call contains ASCII diagram with code blocks', async () => {
      const llmOutput = [
        'He completado el diseño arquitectónico.',
        '```tool_call',
        '{',
        '  "name": "write_architecture_doc",',
        '  "arguments": {',
        '    "code": "ARCH-001",',
        '    "title": "Technical Architecture",',
        '    "content": "# ARCH-001\\n\\n```\\n+-----+ --> +-----+\\n| CLI |     | API |\\n+-----+ <-- +-----+\\n```\\nMonorepo in workspace.",',
        '    "tracesTo": ["REQ-001", "ADR-001"]',
        '  }',
        '}',
        '```',
        'Awaiting approval.',
      ].join('\n');

      const extracted = extractToolCalls(llmOutput);
      expect(extracted.toolCalls).toHaveLength(1);
      expect(extracted.toolCalls[0].name).toBe('write_architecture_doc');

      const call = extracted.toolCalls[0];
      const art = storage.saveArtifact({
        projectId,
        code: call.arguments.code as string,
        type: 'ARCHITECTURE',
        title: call.arguments.title as string,
        content: call.arguments.content as string,
        authorRole: 'architect',
        tracesTo: call.arguments.tracesTo as string[],
      });

      expect(fs.existsSync(art.filePath)).toBe(true);
      expect(art.filePath).toContain(
        path.join('contracts', 'architecture', 'ARCH-001_v1.md'),
      );
      expect(fs.readFileSync(art.filePath, 'utf8')).toContain('+-----+ --> +-----+');
    });

    it('enforces workspace repos/ layout with .git extension and routes source code into repos/', () => {
      const project = storage.getProject(projectId)!;
      const ws = project.workspaceDir;

      // 1. repos/ directory exists by default
      expect(fs.existsSync(path.join(ws, 'repos'))).toBe(true);
      expect(fs.existsSync(path.join(ws, 'contracts'))).toBe(true);
      expect(fs.existsSync(path.join(ws, 'deliveries'))).toBe(true);
      expect(fs.existsSync(path.join(ws, 'outputs'))).toBe(true);
      expect(fs.existsSync(path.join(ws, 'scripts'))).toBe(true);

      // 2. Default single repository directory ends with .git
      const defaultRepoDir = path.join(ws, 'repos', 'SSOT-Demo-Project.git');
      expect(fs.existsSync(defaultRepoDir)).toBe(true);
      expect(project.repositories).toContain('SSOT-Demo-Project.git');

      // 3. write_source_file with bare path routes into repos/<project-name>.git/
      const art1 = storage.saveArtifact({
        projectId,
        code: 'CODE-001',
        type: 'SOURCE_CODE',
        title: 'Source Code (src/index.ts)',
        content: 'console.log("hello world");',
        authorRole: 'developer',
        customRelPath: 'src/index.ts',
      });

      expect(fs.existsSync(art1.filePath)).toBe(true);
      expect(art1.filePath).toBe(
        path.join(ws, 'repos', 'SSOT-Demo-Project.git', 'src', 'index.ts'),
      );

      // 4. write_source_file with multi-repo path ending with .git
      const art2 = storage.saveArtifact({
        projectId,
        code: 'CODE-002',
        type: 'SOURCE_CODE',
        title: 'Source Code (repos/worker.git/main.rs)',
        content: 'fn main() {}',
        authorRole: 'developer',
        customRelPath: 'repos/worker.git/main.rs',
      });

      expect(fs.existsSync(art2.filePath)).toBe(true);
      expect(art2.filePath).toBe(
        path.join(ws, 'repos', 'worker.git', 'main.rs'),
      );

      // 5. write_source_file with un-suffixed repo name normalizes to .git
      const art3 = storage.saveArtifact({
        projectId,
        code: 'CODE-003',
        type: 'SOURCE_CODE',
        title: 'Source Code (auth-service/server.py)',
        content: 'import sys',
        authorRole: 'developer',
        customRelPath: 'repos/auth-service/server.py',
      });

      expect(fs.existsSync(art3.filePath)).toBe(true);
      expect(art3.filePath).toBe(
        path.join(ws, 'repos', 'auth-service.git', 'server.py'),
      );

      // 6. Project repositories in SQLite reflect all discovered .git repos
      const updatedProj = storage.getProject(projectId)!;
      expect(updatedProj.repositories).toContain('SSOT-Demo-Project.git');
      expect(updatedProj.repositories).toContain('worker.git');
      expect(updatedProj.repositories).toContain('auth-service.git');
      expect(updatedProj.repositories.every((r) => r.endsWith('.git'))).toBe(true);
    });

    it('formats clean markdown table of created and modified artifacts (Issue #58)', () => {
      const orchestrator = new PoCliOrchestrator(storage);
      const ws = storage.getProject(projectId)!.workspaceDir;

      const art1 = storage.saveArtifact({
        projectId,
        code: 'ARCH-001',
        type: 'ARCHITECTURE',
        title: 'Core Architecture',
        content: '# ARCH-001',
        authorRole: 'architect',
      });

      const art2 = storage.saveArtifact({
        projectId,
        code: 'SPEC-001',
        type: 'SPECIFICATION',
        title: 'Tech Spec',
        content: '# SPEC-001',
        authorRole: 'architect',
      });

      // art1 updated to version 2 (modified)
      const art1v2 = storage.saveArtifact({
        projectId,
        code: 'ARCH-001',
        type: 'ARCHITECTURE',
        title: 'Core Architecture Updated',
        content: '# ARCH-001 v2',
        authorRole: 'architect',
        expectedVersion: 1,
      });

      // Spanish summary table
      const tableEs = orchestrator.formatArtifactsSummaryTable([art2, art1v2], 'es', ws);
      expect(tableEs).toContain('### Resumen de Ficheros y Artefactos');
      expect(tableEs).toContain('| Artefacto | Tipo | Versión | Operación | Fichero |');
      expect(tableEs).toContain('| `SPEC-001` | Especificación | v1 | Creado | `contracts/specification/SPEC-001_v1.md` |');
      expect(tableEs).toContain('| `ARCH-001` | Arquitectura | v2 | Modificado | `contracts/architecture/ARCH-001_v2.md` |');

      // English summary table
      const tableEn = orchestrator.formatArtifactsSummaryTable([art2, art1v2], 'en', ws);
      expect(tableEn).toContain('### Artifacts & Files Summary');
      expect(tableEn).toContain('| Artifact | Type | Version | Operation | File |');
      expect(tableEn).toContain('| `SPEC-001` | Specification | v1 | Created | `contracts/specification/SPEC-001_v1.md` |');
      expect(tableEn).toContain('| `ARCH-001` | Architecture | v2 | Modified | `contracts/architecture/ARCH-001_v2.md` |');
    });

    it('extracts handoff_to_developer tool call and suppresses it from cleanText', () => {
      const raw = [
        'Comprendido, doy la orden al Senior Developer para iniciar la implementación.',
        '```tool_call',
        '{',
        '  "name": "handoff_to_developer",',
        '  "arguments": {',
        '    "instructions": "Inicia la implementación del servicio en repos/my-api.git según SPEC-001.",',
        '    "approvalComments": "Aprobado por el Product Owner en diálogo."',
        '  }',
        '}',
        '```',
        'El traspaso ha quedado registrado.',
      ].join('\n');

      const res = extractToolCalls(raw);
      expect(res.toolCalls).toHaveLength(1);
      expect(res.toolCalls[0].name).toBe('handoff_to_developer');
      expect(res.toolCalls[0].arguments.instructions).toContain('repos/my-api.git');
      expect(res.cleanText).toContain('Comprendido, doy la orden al Senior Developer');
      expect(res.cleanText).toContain('El traspaso ha quedado registrado.');
      expect(res.cleanText).not.toContain('handoff_to_developer');
    });

    it('executes handoff_to_developer: approves architecture, completes handoff, and transitions to PHASE_5_IMPLEMENTATION', async () => {
      const testDbPath = path.join(tmpDir, 'test-handoff.sqlite');
      const storage = new PoCliDatabase(testDbPath);
      const wsDir = path.join(tmpDir, 'test-handoff-ws');
      fs.mkdirSync(wsDir, { recursive: true });

      const project = storage.createProject({
        name: 'test-handoff',
        description: 'Test Handoff Flow',
        workspaceDir: wsDir,
      });

      // Advance to PHASE_2 and create contracts
      storage.transitionPhase(project.id, 'PHASE_2_ARCHITECT_ANALYSIS');

      storage.saveArtifact({
        projectId: project.id,
        code: 'REQ-001',
        type: 'REQUIREMENT',
        title: 'User Requirements',
        content: '# REQ-001',
        authorRole: 'architect',
        status: 'DRAFT',
      });

      storage.saveArtifact({
        projectId: project.id,
        code: 'ADR-001',
        type: 'ADR',
        title: 'FastAPI Choice',
        content: '# ADR-001',
        authorRole: 'architect',
        status: 'DRAFT',
      });

      storage.saveArtifact({
        projectId: project.id,
        code: 'ARCH-001',
        type: 'ARCHITECTURE',
        title: 'System Architecture',
        content: '# ARCH-001: Architecture Details',
        authorRole: 'architect',
        status: 'PENDING_APPROVAL',
      });

      storage.saveArtifact({
        projectId: project.id,
        code: 'SPEC-001',
        type: 'SPECIFICATION',
        title: 'Technical Specification',
        content: '# SPEC-001: Technical Details',
        authorRole: 'architect',
        status: 'DRAFT',
      });

      // Advance to PHASE_3_ARCHITECTURE_APPROVAL
      storage.transitionPhase(project.id, 'PHASE_3_ARCHITECTURE_APPROVAL');

      const orchestrator = new PoCliOrchestrator(storage);

      // Execute handoff_to_developer tool call
      const result = await (orchestrator as any).executeAgentToolCalls(
        project.id,
        'architect',
        [
          {
            name: 'handoff_to_developer',
            arguments: {
              instructions: 'Implement the FastAPI service in repos/test-handoff.git according to SPEC-001.',
              approvalComments: 'Verbally approved by PO in chat conversation.',
            },
          },
        ],
      );

      // Verify autonomous handoff payload
      expect(result.autonomousHandoff).toBeDefined();
      expect(result.autonomousHandoff?.nextRole).toBe('developer');
      expect(result.autonomousHandoff?.instructions).toContain('repos/test-handoff.git');

      // Verify project state in database
      const updatedProj = storage.getProject(project.id)!;
      expect(updatedProj.phase).toBe('PHASE_5_IMPLEMENTATION');
      expect(updatedProj.approvedArchitectureVersion).toBe(1);

      // Verify contract statuses updated to APPROVED
      const arch = storage.getLatestArtifactByCode(project.id, 'ARCH-001')!;
      expect(arch.status).toBe('APPROVED');

      const spec = storage.getLatestArtifactByCode(project.id, 'SPEC-001')!;
      expect(spec.status).toBe('APPROVED');

      // Verify official Architect -> Developer handoff message in DAG
      const msgs = storage.listMessages(project.id);
      const handoffMsg = msgs.find(
        (m) => m.fromRole === 'architect' && m.toRole === 'developer',
      );
      expect(handoffMsg).toBeDefined();
      expect(handoffMsg?.content).toContain('# Normative Developer Handoff Bundle');
      expect(handoffMsg?.content).toContain('ARCH-001');
      expect(handoffMsg?.content).toContain('SPEC-001');
    });
  });
});
