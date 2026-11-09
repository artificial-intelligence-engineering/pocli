import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PoCliDatabase,
  PoCliOrchestrator,
} from '../src/index.js';

describe('QA Autonomous Tool & Dependency Provisioning in scripts/ (Issue #96)', () => {
  let tmpDir: string;
  let storage: PoCliDatabase;
  let orchestrator: PoCliOrchestrator;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocli-qa-tool-prov-test-'));
    storage = new PoCliDatabase(path.join(tmpDir, 'pocli.sqlite'));
    orchestrator = new PoCliOrchestrator(storage);
  });

  afterEach(() => {
    orchestrator.rag.stopWatchers();
    storage.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1. ensureQaToolEnvironment provisions an isolated venv in scripts/.venv and installs robotframework', () => {
    const wsDir = path.join(tmpDir, 'ws-tool-prov-1');
    const project = orchestrator.createProject({
      name: 'QaToolProvApp',
      description: 'Test ensureQaToolEnvironment',
      workspaceDir: wsDir,
    });

    const res = orchestrator.ensureQaToolEnvironment(project.id, 'robotframework');

    // 1. Check return structure
    expect(res.toolName).toBe('robotframework');
    expect(res.installedNow).toBe(true);
    expect(res.installed).toBe(true);

    // 2. Check virtual environment directory in scripts/.venv
    const scriptsDir = path.join(wsDir, 'scripts');
    const venvDir = path.join(scriptsDir, '.venv');
    expect(res.venvDir).toBe(venvDir);
    expect(fs.existsSync(venvDir)).toBe(true);

    // 3. Check python and robot binaries exist inside isolated venv
    expect(fs.existsSync(res.pythonBin)).toBe(true);
    expect(fs.existsSync(res.robotBin)).toBe(true);

    // 4. Calling again is idempotent and fast without re-installing
    const resSecond = orchestrator.ensureQaToolEnvironment(project.id, 'robotframework');
    expect(resSecond.installedNow).toBe(false);
    expect(resSecond.installed).toBe(false);
    expect(fs.existsSync(resSecond.robotBin)).toBe(true);
  }, 40000);

  it('2. QA agent tool call install_qa_tool creates QA-TOOL-001 observation artifact in scripts/qa-tools.md', async () => {
    const wsDir = path.join(tmpDir, 'ws-tool-prov-2');
    const project = orchestrator.createProject({
      name: 'QaToolCallApp',
      description: 'Test install_qa_tool tool call execution',
      workspaceDir: wsDir,
    });

    const toolResult = await orchestrator.executeAgentToolCalls(project.id, 'qa', [
      {
        name: 'install_qa_tool',
        arguments: {
          toolName: 'robotframework',
        },
      },
    ]);

    expect(toolResult.createdArtifacts.length).toBe(1);
    const toolArt = toolResult.createdArtifacts[0];
    expect(toolArt.code).toBe('QA-TOOL-001');
    expect(toolArt.title).toContain('robotframework');

    const qaToolsFile = path.join(wsDir, 'scripts', 'qa-tools.md');
    expect(fs.existsSync(qaToolsFile)).toBe(true);
    const content = fs.readFileSync(qaToolsFile, 'utf8');
    expect(content).toContain('# QA-TOOL-001');
    expect(content).toContain('scripts/.venv');
  }, 40000);

  it('3. runIsolatedQaSuite executes genuine Robot Framework test suite and generates output.xml, log.html, report.html in scripts/qa-logs/', async () => {
    const wsDir = path.join(tmpDir, 'ws-tool-prov-3');
    const project = orchestrator.createProject({
      name: 'QaRobotExecutionApp',
      description: 'Test genuine Robot Framework execution',
      workspaceDir: wsDir,
    });

    // Write a dummy JS application file in src/
    const srcDir = path.join(wsDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, 'app-module.js'),
      `export function executeBusinessLogic(input) {
  if (!input || typeof input.value !== 'number') throw new Error('INVALID_INPUT');
  return { ok: true, result: input.value * 2 };
}
`,
      'utf8',
    );

    // QA writes a genuine Robot Framework suite in scripts/qa_suite.robot
    const scriptsDir = path.join(wsDir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    const robotContent = [
      `*** Settings ***`,
      `Documentation     Acceptance Suite for ${project.name}`,
      `Library           Process`,
      ``,
      `*** Test Cases ***`,
      `TC-001 Nominal Math Execution`,
      `    [Documentation]    Verifies node execution of business logic`,
      `    \${res}=    Run Process    node    qa_adversarial_runner.mjs    cwd=\${CURDIR}`,
      `    Should Be Equal As Integers    \${res.rc}    0`,
      ``,
      `TC-002 Boundary Calculation`,
      `    [Documentation]    Verifies boundary process execution`,
      `    \${res}=    Run Process    node    -e    process.exit(0)    cwd=\${CURDIR}`,
      `    Should Be Equal As Integers    \${res.rc}    0`,
    ].join('\n');

    fs.writeFileSync(path.join(scriptsDir, 'qa_suite.robot'), robotContent, 'utf8');

    // Run isolated QA suite in auto mode
    const suiteRes = orchestrator.runIsolatedQaSuite({
      projectId: project.id,
      command: 'auto',
    });

    expect(suiteRes.passed).toBe(true);
    expect(suiteRes.exitCode).toBe(0);
    expect(suiteRes.executedTests.length).toBeGreaterThanOrEqual(2);
    expect(suiteRes.passedTests).toContain('TC-001 Nominal Math Execution');
    expect(suiteRes.passedTests).toContain('TC-002 Boundary Calculation');

    // Verify Robot Framework generated genuine output.xml, log.html, and report.html in scripts/qa-logs/
    const qaLogsDir = path.join(scriptsDir, 'qa-logs');
    const outputXmlPath = path.join(qaLogsDir, 'output.xml');
    const logHtmlPath = path.join(qaLogsDir, 'log.html');
    const reportHtmlPath = path.join(qaLogsDir, 'report.html');

    expect(fs.existsSync(outputXmlPath)).toBe(true);
    expect(fs.existsSync(logHtmlPath)).toBe(true);
    expect(fs.existsSync(reportHtmlPath)).toBe(true);

    const xmlContent = fs.readFileSync(outputXmlPath, 'utf8');
    expect(xmlContent).toContain('<robot');
    expect(xmlContent).toContain('TC-001 Nominal Math Execution');
    expect(xmlContent).toContain('status="PASS"');

    const logHtmlContent = fs.readFileSync(logHtmlPath, 'utf8');
    expect(logHtmlContent).toContain('window.output'); // Robot Framework log.html JS signature
  }, 40000);

  it('4. runIsolatedQaSuite with custom robot command uses isolated venv PATH automatically', () => {
    const wsDir = path.join(tmpDir, 'ws-tool-prov-4');
    const project = orchestrator.createProject({
      name: 'QaCustomCmdApp',
      description: 'Test custom command robot execution',
      workspaceDir: wsDir,
    });

    // Run custom command invoking robot --version
    const suiteRes = orchestrator.runIsolatedQaSuite({
      projectId: project.id,
      command: 'robot --version || true',
    });

    expect(suiteRes.passed).toBe(true);
    expect(suiteRes.stdout + suiteRes.stderr).toContain('Robot Framework');

    // Verify venv was created in scripts/.venv
    expect(fs.existsSync(path.join(wsDir, 'scripts', '.venv', 'bin', 'robot'))).toBe(true);
  }, 40000);
});
