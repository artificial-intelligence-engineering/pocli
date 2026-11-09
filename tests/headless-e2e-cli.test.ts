import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HeadlessCliRunner,
  PoCliDatabase,
  PoCliOrchestrator,
  runVirtualTuiSession,
} from '../src/index.js';

describe('Headless CLI & Virtual TUI End-to-End Automation (Issue #92)', () => {
  let tmpDir: string;
  let storage: PoCliDatabase;
  let orchestrator: PoCliOrchestrator;
  let runner: HeadlessCliRunner;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocli-headless-test-'));
    storage = new PoCliDatabase(path.join(tmpDir, 'pocli.sqlite'));
    orchestrator = new PoCliOrchestrator(storage);
    runner = new HeadlessCliRunner(orchestrator);
  });

  afterEach(async () => {
    orchestrator.rag.stopWatchers();
    await orchestrator.stopAllWorkers();
    storage.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1. HeadlessCliRunner.executeCommand executes slash commands (/project, /status, /approve, /handoff, /accept) headlessly', async () => {
    const wsDir = path.join(tmpDir, 'ws-exec');
    const createRes = await runner.executeCommand({
      commandOrPrompt: '/project ExecDemoApp Automated CLI test project',
      workspaceDir: wsDir,
    });
    expect(createRes.ok).toBe(true);
    expect(createRes.project?.name).toBe('ExecDemoApp');

    const archRes = await runner.executeCommand({
      commandOrPrompt: 'Design and propose the formal architecture and requirements.',
      role: 'architect',
      modelSpec: 'deterministic/pocli-specialist-v1',
    });
    expect(archRes.ok).toBe(true);
    expect(archRes.project?.phase).toBe('PHASE_3_ARCHITECTURE_APPROVAL');

    const approveRes = await runner.executeCommand({
      commandOrPrompt: '/approve ARCH-001 Approved in headless mode',
    });
    expect(approveRes.project?.phase).toBe('PHASE_4_DEVELOPER_HANDOFF');

    const handoffRes = await runner.executeCommand({
      commandOrPrompt: '/handoff Implement ARCH-001 and SPEC-001 and run QA',
    });
    expect(handoffRes.project?.phase).toBe('PHASE_8_FINAL_ACCEPTANCE');
    expect(handoffRes.outputText).toContain('[QA → ARQ]');

    const acceptRes = await runner.executeCommand({
      commandOrPrompt: '/accept Verified end-to-end via headless CLI',
    });
    expect(acceptRes.project?.phase).toBe('COMPLETED');
  }, 30000);

  it('2. HeadlessCliRunner.runFullE2eLifecycle executes full E2E including QA <-> Developer correction loop', async () => {
    const wsDir = path.join(tmpDir, 'ws-e2e-loop');
    const e2eRes = await runner.runFullE2eLifecycle({
      projectName: 'AutoLoopE2E',
      workspaceDir: wsDir,
      simulateDefectCycle: true,
      useDeterministicModel: true,
    });

    expect(e2eRes.ok).toBe(true);
    expect(e2eRes.finalPhase).toBe('COMPLETED');
    expect(e2eRes.correctionCycles).toBe(1);
    expect(e2eRes.qaSummaryTable).toContain('[QA → ARQ]');
    expect(e2eRes.qaSummaryTable).toContain('TC-001');
    expect(e2eRes.qaSummaryTable).toContain('TC-MUT-001');
    expect(e2eRes.artifacts.some((a) => a.code === 'REG-GHERKIN-001')).toBe(true);
  }, 30000);

  it('3. runVirtualTuiSession drives the real Ink CommandCenterApp TUI end-to-end without blocking stdin', async () => {
    const wsDir = path.join(tmpDir, 'ws-virtual-tui');
    const proj = runner.ensureProject({
      projectName: 'TuiDrivenApp',
      workspaceDir: wsDir,
      useDeterministicModel: true,
    });

    const tuiRes = await runVirtualTuiSession({
      orchestrator,
      initialProject: proj,
      steps: [
        { input: '/agents architect\r', waitMs: 200 },
        {
          input: 'Design and propose the formal architecture and requirements.\r',
          waitMs: 800,
        },
        {
          input: 'Procede con la arquitectura propuesta y delega al desarrollador.\r',
          waitMs: 5000,
        },
      ],
    });

    expect(tuiRes.ok).toBe(true);
    expect(tuiRes.framesCount).toBeGreaterThan(5);
    expect(tuiRes.finalProject?.phase).toBe('PHASE_8_FINAL_ACCEPTANCE');
    expect(tuiRes.allTextCombined).toContain('[QA → ARQ]');
    expect(tuiRes.allTextCombined).toContain('TC-MUT-001');
  }, 30000);
});
