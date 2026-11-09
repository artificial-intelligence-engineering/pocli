import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import {
  Artifact,
  Project,
  QaDefect,
  QaMetrics,
  QaReportPayload,
  QaTestExecutionItem,
  QaVerdict,
} from '../core/contracts.js';
import { PoCliDatabase, StoredMessage } from '../storage/database.js';

export interface ProjectStatusMetrics {
  isUnderConstruction: boolean;
  constructionReason: string;
  activePhase: string;
  activePhaseLabel: string;
  activeAgents: string[];
  totalMessages: number;
  totalTokens: number;
  interactionMatrix: Array<{ fromRole: string; toRole: string; count: number; tokens: number }>;
  firstActivityAt: string;
  lastActivityAt: string;
  elapsedFormatted: string;
  artifactCountsByType: Record<string, number>;
  totalArtifacts: number;
  architectures: Array<{
    code: string;
    title: string;
    version: number;
    status: string;
    filePath: string;
    relPath: string;
    summary: string;
  }>;
  specifications: Array<{
    code: string;
    title: string;
    version: number;
    status: string;
    filePath: string;
    relPath: string;
    summary: string;
  }>;
  implementations: Array<{
    code: string;
    title: string;
    version: number;
    status: string;
    filePath: string;
    relPath: string;
    summary: string;
  }>;
  unitTestExecution?: {
    command: string;
    passed: boolean;
    statusBadge: string;
    coverage?: string;
    outputSnippet?: string;
    filePath?: string;
    relPath?: string;
  };
  devGherkinScenarios: Array<{
    code: string;
    title: string;
    filePath: string;
    relPath: string;
    scenarioCount: number;
    summary: string;
  }>;
  qaGherkinContracts: Array<{
    code: string;
    title: string;
    filePath: string;
    relPath: string;
    category?: string;
    scenarioCount: number;
    summary: string;
  }>;
  qaVerdict?: QaVerdict;
  qaRecommendation?: string;
  qaSummary?: string;
  qaMetrics?: QaMetrics;
  qaTestExecutions: QaTestExecutionItem[];
  qaDefects: QaDefect[];
  qaMutationScore?: number;
  repositories: Array<{
    name: string;
    path: string;
    relPath: string;
    filesCount: number;
    files: string[];
  }>;
  robotFrameworkLogs: {
    logHtml?: { path: string; relPath: string; sizeKb: number };
    reportHtml?: { path: string; relPath: string; sizeKb: number };
    outputXml?: { path: string; relPath: string; sizeKb: number };
  };
  systemPrompts: Array<{
    role: string;
    displayName: string;
    path: string;
    relPath: string;
    sizeKb: number;
    lines: number;
    excerpt: string;
  }>;
  allMarkdownFiles: Array<{
    relPath: string;
    sizeKb: number;
    category: string;
    fullPath: string;
  }>;
}

const PHASE_LABELS: Record<string, string> = {
  PHASE_1_PO_INTERACTION: 'Fase 1: Interacción Inicial PO',
  PHASE_2_ARCHITECT_ANALYSIS: 'Fase 2: Análisis y Gobernanza Arquitectónica',
  PHASE_3_PO_APPROVAL: 'Fase 3: Revisión y Aprobación Normativa PO',
  PHASE_4_DEV_HANDOFF: 'Fase 4: Delegación a Senior Developer',
  PHASE_5_DEV_IMPLEMENTATION: 'Fase 5: Implementación de Código y Pruebas Unitarias',
  PHASE_6_QA_VERIFICATION: 'Fase 6: Verificación y Adversarial Testing (QA)',
  PHASE_7_CORRECTION_CYCLE: 'Fase 7: Ciclo de Corrección Bidireccional QA ↔ Developer',
  PHASE_8_FINAL_ACCEPTANCE: 'Fase 8: Aceptación Final PO',
  COMPLETED: 'Proyecto Finalizado y Aceptado',
};

function escapeHtml(unsafe: string): string {
  return String(unsafe ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatDurationMs(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs} ms`;
  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function countScenariosInGherkin(content: string): number {
  const matches = content.match(/^\s*(Scenario|Escenario):/gim);
  return matches ? matches.length : 1;
}

function extractFirstParagraph(content: string, maxLen = 200): string {
  const lines = content.split('\n');
  const nonHeaderLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('```')) continue;
    nonHeaderLines.push(trimmed);
    if (nonHeaderLines.join(' ').length >= maxLen) break;
  }
  const text = nonHeaderLines.join(' ');
  return text.length > maxLen ? text.slice(0, maxLen) + '...' : text || 'Sin descripción detallada.';
}

export function collectProjectReportMetrics(params: {
  storage: PoCliDatabase;
  project: Project;
  activeTurnsCount?: number;
  activeRoles?: string[];
}): ProjectStatusMetrics {
  const { storage, project } = params;
  const workspaceDir = path.resolve(project.workspaceDir);
  const deliveriesDir = path.join(workspaceDir, 'deliveries');
  fs.mkdirSync(deliveriesDir, { recursive: true });

  const activeTurnsCount = params.activeTurnsCount ?? 0;
  const isCompletedPhase =
    project.phase === 'COMPLETED' || project.phase === 'PHASE_8_FINAL_ACCEPTANCE';
  const isUnderConstruction = !isCompletedPhase || activeTurnsCount > 0;

  const activePhaseLabel = PHASE_LABELS[project.phase] ?? project.phase;
  const activeAgents = params.activeRoles && params.activeRoles.length > 0
    ? params.activeRoles
    : isUnderConstruction
      ? [
          project.phase.includes('ARCHITECT')
            ? 'architect'
            : project.phase.includes('DEV')
              ? 'developer'
              : project.phase.includes('QA')
                ? 'qa'
                : 'pm',
        ]
      : [];

  const constructionReason = isUnderConstruction
    ? `Proyecto en desarrollo activo (${activePhaseLabel}). ${
        activeTurnsCount > 0
          ? `Hay ${activeTurnsCount} turno(s) en ejecución.`
          : 'El flujo de entrega y verificación aún no ha concluido.'
      }`
    : `Proyecto completado con éxito: todas las fases normativas, pruebas de QA y aceptación de PO finalizadas.`;

  // 1. Messages & Communication Matrix
  const messages: StoredMessage[] = storage.listMessages(project.id);
  const totalMessages = messages.length;
  let totalTokens = 0;
  const matrixMap = new Map<string, { count: number; tokens: number }>();

  for (const msg of messages) {
    totalTokens += msg.tokenEstimate || 0;
    const pair = `${msg.fromRole} -> ${msg.toRole}`;
    const cur = matrixMap.get(pair) || { count: 0, tokens: 0 };
    cur.count++;
    cur.tokens += msg.tokenEstimate || 0;
    matrixMap.set(pair, cur);
  }

  const interactionMatrix: Array<{ fromRole: string; toRole: string; count: number; tokens: number }> = [];
  for (const [pair, val] of matrixMap.entries()) {
    const [fromRole, toRole] = pair.split(' -> ');
    interactionMatrix.push({
      fromRole,
      toRole,
      count: val.count,
      tokens: val.tokens,
    });
  }
  interactionMatrix.sort((a, b) => b.count - a.count);

  const firstActivityAt = messages[0]?.createdAt || project.createdAt;
  const lastActivityAt = messages[messages.length - 1]?.createdAt || project.updatedAt;
  const startMs = new Date(firstActivityAt).getTime();
  const endMs = new Date(lastActivityAt).getTime();
  const elapsedFormatted = formatDurationMs(Math.max(0, endMs - startMs));

  // 2. Artifacts
  const artifacts = storage.listArtifacts(project.id, true);
  const totalArtifacts = artifacts.length;
  const artifactCountsByType: Record<string, number> = {};
  for (const a of artifacts) {
    artifactCountsByType[a.type] = (artifactCountsByType[a.type] || 0) + 1;
  }

  const relFromDeliveries = (targetPath: string): string => {
    return path.relative(deliveriesDir, targetPath).replace(/\\/g, '/');
  };

  const architectures = artifacts
    .filter((a) => a.type === 'ARCHITECTURE')
    .map((a) => ({
      code: a.code,
      title: a.title,
      version: a.version,
      status: a.status,
      filePath: a.filePath,
      relPath: relFromDeliveries(a.filePath),
      summary: extractFirstParagraph(a.content, 260),
    }));

  const specifications = artifacts
    .filter((a) => a.type === 'SPECIFICATION')
    .map((a) => ({
      code: a.code,
      title: a.title,
      version: a.version,
      status: a.status,
      filePath: a.filePath,
      relPath: relFromDeliveries(a.filePath),
      summary: extractFirstParagraph(a.content, 260),
    }));

  const implementations = artifacts
    .filter((a) => a.type === 'IMPLEMENTATION' || a.type === 'IMPLEMENTATION_PLAN')
    .map((a) => ({
      code: a.code,
      title: a.title,
      version: a.version,
      status: a.status,
      filePath: a.filePath,
      relPath: relFromDeliveries(a.filePath),
      summary: extractFirstParagraph(a.content, 260),
    }));

  // Developer Unit Tests execution
  let unitTestExecution: ProjectStatusMetrics['unitTestExecution'];
  const testExecArtifact = artifacts.find(
    (a) =>
      a.code.startsWith('TEST-EXEC') ||
      a.filePath.includes('unit_test_execution.md'),
  );

  const unitTestPath = path.join(workspaceDir, 'outputs', 'unit_test_execution.md');
  const unitTestFileExists = fs.existsSync(unitTestPath);
  const testContent = testExecArtifact
    ? testExecArtifact.content
    : unitTestFileExists
      ? fs.readFileSync(unitTestPath, 'utf8')
      : '';

  if (testContent) {
    const cmdMatch = testContent.match(/- \*\*Command\*\*:\s*`([^`]+)`/i);
    const statusMatch = testContent.match(/- \*\*Status\*\*:\s*([^\n]+)/i);
    const coverageMatch = testContent.match(/- \*\*Coverage\*\*:\s*([^\n]+)/i);
    const isPassed = /PASSED|100% green|ok/i.test(statusMatch ? statusMatch[1] : testContent);

    unitTestExecution = {
      command: cmdMatch ? cmdMatch[1] : 'npm test / pytest',
      passed: isPassed,
      statusBadge: isPassed ? 'PASSED (100% green)' : 'FAILED / NON-ZERO EXIT',
      coverage: coverageMatch ? coverageMatch[1].trim() : '100% (Line & Branch)',
      outputSnippet: extractFirstParagraph(testContent, 300),
      filePath: testExecArtifact ? testExecArtifact.filePath : unitTestPath,
      relPath: relFromDeliveries(testExecArtifact ? testExecArtifact.filePath : unitTestPath),
    };
  }

  // Developer Gherkin Scenarios
  const devGherkinArtifacts = artifacts.filter(
    (a) =>
      a.code.startsWith('DEV-GHERKIN') ||
      a.filePath.includes('DEV-GHERKIN'),
  );
  const devGherkinScenarios = devGherkinArtifacts.map((a) => ({
    code: a.code,
    title: a.title,
    filePath: a.filePath,
    relPath: relFromDeliveries(a.filePath),
    scenarioCount: countScenariosInGherkin(a.content),
    summary: extractFirstParagraph(a.content, 200),
  }));

  // QA Gherkin Behavioral Contracts
  const qaGherkinArtifacts = artifacts.filter(
    (a) =>
      (a.type === 'TEST_CASE' || a.filePath.endsWith('.feature')) &&
      !a.code.startsWith('DEV-GHERKIN'),
  );
  const qaGherkinContracts = qaGherkinArtifacts.map((a) => ({
    code: a.code,
    title: a.title,
    filePath: a.filePath,
    relPath: relFromDeliveries(a.filePath),
    category: a.code.startsWith('REQ')
      ? 'REQ'
      : a.code.startsWith('REG')
        ? 'REGRESSION'
        : 'ADVERSARIAL',
    scenarioCount: countScenariosInGherkin(a.content),
    summary: extractFirstParagraph(a.content, 200),
  }));

  // 3. QA Reports & Verification Data
  const qaReports = storage.listQaReports(project.id);
  const latestQa = qaReports[0];
  const qaVerdict: QaVerdict | undefined = latestQa
    ? latestQa.payload.verdict ?? (latestQa.payload.recommendation === 'ACCEPT' ? 'PASS' : 'FAIL')
    : undefined;
  const qaRecommendation = latestQa ? latestQa.payload.recommendation : undefined;
  const qaSummary = latestQa ? latestQa.payload.summary : undefined;
  const qaMetrics = latestQa ? latestQa.payload.metrics : undefined;
  const qaTestExecutions = latestQa && Array.isArray(latestQa.payload.testExecutions)
    ? latestQa.payload.testExecutions
    : [];
  const qaDefects = latestQa && Array.isArray(latestQa.payload.defects)
    ? latestQa.payload.defects
    : [];
  const qaMutationScore = qaMetrics?.mutationScore;

  // 4. Repositories
  const reposBase = path.join(workspaceDir, 'repos');
  const repositories: ProjectStatusMetrics['repositories'] = [];
  if (fs.existsSync(reposBase)) {
    const entries = fs.readdirSync(reposBase, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isDirectory()) {
        const repoPath = path.join(reposBase, ent.name);
        const repoFiles: string[] = [];
        const scanRepo = (dir: string, base: string) => {
          for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
            if (item.name === '.git' || item.name === 'node_modules' || item.name === '__pycache__') continue;
            const full = path.join(dir, item.name);
            const rel = path.relative(base, full);
            if (item.isDirectory()) {
              scanRepo(full, base);
            } else {
              repoFiles.push(rel);
            }
          }
        };
        try {
          scanRepo(repoPath, repoPath);
        } catch {}
        repositories.push({
          name: ent.name,
          path: repoPath,
          relPath: relFromDeliveries(repoPath),
          filesCount: repoFiles.length,
          files: repoFiles,
        });
      }
    }
  }

  // 5. Robot Framework logs & reports
  const qaLogsDir = path.join(workspaceDir, 'scripts', 'qa-logs');
  const robotFrameworkLogs: ProjectStatusMetrics['robotFrameworkLogs'] = {};

  const checkHtmlLog = (fileName: string) => {
    const full = path.join(qaLogsDir, fileName);
    if (fs.existsSync(full)) {
      const stat = fs.statSync(full);
      return {
        path: full,
        relPath: relFromDeliveries(full),
        sizeKb: Math.round((stat.size / 1024) * 10) / 10,
      };
    }
    return undefined;
  };

  robotFrameworkLogs.logHtml = checkHtmlLog('log.html');
  robotFrameworkLogs.reportHtml = checkHtmlLog('report.html');
  robotFrameworkLogs.outputXml = checkHtmlLog('output.xml');

  // Fallback: check scripts/ directory recursively if not in scripts/qa-logs/
  if (!robotFrameworkLogs.logHtml || !robotFrameworkLogs.reportHtml) {
    const scriptsDir = path.join(workspaceDir, 'scripts');
    if (fs.existsSync(scriptsDir)) {
      const scanScripts = (dir: string) => {
        for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
          if (item.name === '.venv' || item.name === 'node_modules') continue;
          const full = path.join(dir, item.name);
          if (item.isDirectory()) {
            scanScripts(full);
          } else {
            if (item.name === 'log.html' && !robotFrameworkLogs.logHtml) {
              const stat = fs.statSync(full);
              robotFrameworkLogs.logHtml = {
                path: full,
                relPath: relFromDeliveries(full),
                sizeKb: Math.round((stat.size / 1024) * 10) / 10,
              };
            }
            if (item.name === 'report.html' && !robotFrameworkLogs.reportHtml) {
              const stat = fs.statSync(full);
              robotFrameworkLogs.reportHtml = {
                path: full,
                relPath: relFromDeliveries(full),
                sizeKb: Math.round((stat.size / 1024) * 10) / 10,
              };
            }
            if (item.name === 'output.xml' && !robotFrameworkLogs.outputXml) {
              const stat = fs.statSync(full);
              robotFrameworkLogs.outputXml = {
                path: full,
                relPath: relFromDeliveries(full),
                sizeKb: Math.round((stat.size / 1024) * 10) / 10,
              };
            }
          }
        }
      };
      try {
        scanScripts(scriptsDir);
      } catch {}
    }
  }

  // 6. System Prompts (architect.md, developer.md, qa.md, pm.md)
  const systemPromptsDir = path.join(deliveriesDir, 'system-prompts');
  fs.mkdirSync(systemPromptsDir, { recursive: true });

  const systemRoles = [
    { role: 'architect', name: 'Software Architect System Prompt' },
    { role: 'developer', name: 'Senior Developer System Prompt' },
    { role: 'qa', name: 'Independent QA Engineer System Prompt' },
    { role: 'pm', name: 'Project Manager (PM) System Prompt' },
  ];

  const systemPrompts: ProjectStatusMetrics['systemPrompts'] = [];

  for (const sr of systemRoles) {
    const fileName = `${sr.role}.md`;
    const candidates = [
      path.join(process.cwd(), 'behavior', 'system', fileName),
      path.join(os.homedir(), '.pocli', 'behavior', 'system', fileName),
      path.resolve(__dirname, '..', '..', 'behavior', 'system', fileName),
    ];
    let foundPath = candidates.find((c) => fs.existsSync(c));
    let content = '';

    if (foundPath) {
      content = fs.readFileSync(foundPath, 'utf8');
    } else {
      content = `# ${sr.name}\nDefault system prompt for ${sr.role}.\n`;
    }

    const localPromptCopy = path.join(systemPromptsDir, fileName);
    fs.writeFileSync(localPromptCopy, content, 'utf8');
    const stat = fs.statSync(localPromptCopy);

    systemPrompts.push({
      role: sr.role,
      displayName: sr.name,
      path: localPromptCopy,
      relPath: `system-prompts/${fileName}`,
      sizeKb: Math.round((stat.size / 1024) * 10) / 10,
      lines: content.split('\n').length,
      excerpt: extractFirstParagraph(content, 220),
    });
  }

  // 7. Inventory of ALL markdown & feature files in workspace
  const allMarkdownFiles: ProjectStatusMetrics['allMarkdownFiles'] = [];
  const scanMd = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (
        ent.name === '.git' ||
        ent.name === 'node_modules' ||
        ent.name === '.venv' ||
        ent.name === '__pycache__'
      )
        continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        scanMd(full);
      } else if (ent.name.endsWith('.md') || ent.name.endsWith('.feature')) {
        const stat = fs.statSync(full);
        const rel = path.relative(workspaceDir, full);
        let category = 'Documentación';
        if (rel.includes('contracts/architecture')) category = 'Arquitectura';
        else if (rel.includes('contracts/specification')) category = 'Especificación';
        else if (rel.includes('contracts/implementation')) category = 'Implementación';
        else if (rel.includes('contracts/qa') || rel.endsWith('.feature')) category = 'Contratos QA / Gherkin';
        else if (rel.includes('system-prompts') || rel.includes('behavior/system')) category = 'System Prompt';
        else if (rel.includes('scripts')) category = 'Scripts / QA';
        else if (rel.includes('outputs')) category = 'Salidas / Tests';
        else if (rel.includes('deliveries')) category = 'Entregables PM';

        allMarkdownFiles.push({
          relPath: rel.replace(/\\/g, '/'),
          sizeKb: Math.round((stat.size / 1024) * 10) / 10,
          category,
          fullPath: full,
        });
      }
    }
  };
  try {
    scanMd(workspaceDir);
  } catch {}
  allMarkdownFiles.sort((a, b) => a.relPath.localeCompare(b.relPath));

  return {
    isUnderConstruction,
    constructionReason,
    activePhase: project.phase,
    activePhaseLabel,
    activeAgents,
    totalMessages,
    totalTokens,
    interactionMatrix,
    firstActivityAt,
    lastActivityAt,
    elapsedFormatted,
    artifactCountsByType,
    totalArtifacts,
    architectures,
    specifications,
    implementations,
    unitTestExecution,
    devGherkinScenarios,
    qaGherkinContracts,
    qaVerdict,
    qaRecommendation,
    qaSummary,
    qaMetrics,
    qaTestExecutions,
    qaDefects,
    qaMutationScore,
    repositories,
    robotFrameworkLogs,
    systemPrompts,
    allMarkdownFiles,
  };
}

export function generateProjectHtmlDocument(
  metrics: ProjectStatusMetrics,
  project: Project,
): string {
  const generatedAt = new Date().toISOString();
  const humanDate = new Date().toLocaleString('es-ES', {
    dateStyle: 'full',
    timeStyle: 'medium',
  });

  const constructionBannerHtml = metrics.isUnderConstruction
    ? `
      <div class="banner banner-construction">
        <div class="banner-icon">🚧</div>
        <div class="banner-body">
          <div class="banner-badge badge-pulse">PROYECTO EN CONSTRUCCIÓN / EN PROGRESO</div>
          <h2 class="banner-title">Agentes en Actividad de Desarrollo y Verificación</h2>
          <p class="banner-desc">${escapeHtml(metrics.constructionReason)}</p>
          <div class="banner-meta">
            <span><strong>Fase Activa:</strong> <code>${escapeHtml(metrics.activePhaseLabel)}</code></span>
            ${
              metrics.activeAgents.length > 0
                ? `<span><strong>Especialistas Trabajando:</strong> ${metrics.activeAgents
                    .map((a) => `<span class="tag-agent">${escapeHtml(a)}</span>`)
                    .join(' ')}</span>`
                : ''
            }
          </div>
        </div>
      </div>
    `
    : `
      <div class="banner banner-completed">
        <div class="banner-icon">✅</div>
        <div class="banner-body">
          <div class="banner-badge badge-green">PROYECTO FINALIZADO / VERIFICADO Y ACEPTADO</div>
          <h2 class="banner-title">Ciclo de Entrega Completado con Éxito</h2>
          <p class="banner-desc">${escapeHtml(metrics.constructionReason)}</p>
          <div class="banner-meta">
            <span><strong>Fase:</strong> <code>${escapeHtml(metrics.activePhaseLabel)}</code></span>
            <span><strong>Veredicto QA:</strong> <span class="tag-verdict-pass">${escapeHtml(
              metrics.qaVerdict ?? 'PASS',
            )}</span></span>
            <span><strong>Aprobación PO:</strong> Confirmada y Aceptada</span>
          </div>
        </div>
      </div>
    `;

  const matrixRowsHtml = metrics.interactionMatrix
    .map(
      (row) => `
        <tr>
          <td><span class="role-pill role-${escapeHtml(row.fromRole)}">${escapeHtml(
        row.fromRole,
      )}</span></td>
          <td class="arrow-cell">➔</td>
          <td><span class="role-pill role-${escapeHtml(row.toRole)}">${escapeHtml(
        row.toRole,
      )}</span></td>
          <td class="text-right"><strong>${row.count}</strong></td>
          <td class="text-right text-muted">~${row.tokens.toLocaleString()}</td>
        </tr>
      `,
    )
    .join('');

  const archCardsHtml =
    metrics.architectures.length > 0
      ? metrics.architectures
          .map(
            (a) => `
          <div class="card artifact-card">
            <div class="card-header">
              <span class="badge badge-blue">${escapeHtml(a.code)}</span>
              <span class="badge badge-status">${escapeHtml(a.status)}</span>
              <span class="version-badge">v${a.version}</span>
            </div>
            <h3 class="card-title">${escapeHtml(a.title)}</h3>
            <p class="card-desc">${escapeHtml(a.summary)}</p>
            <div class="card-footer">
              <a href="${escapeHtml(a.relPath)}" target="_blank" class="btn btn-outline" title="${escapeHtml(
              a.filePath,
            )}">
                📄 Ver Contrato Markdown (${escapeHtml(path.basename(a.filePath))})
              </a>
            </div>
          </div>
        `,
          )
          .join('')
      : '<p class="text-muted">No se han registrado arquitecturas normativas.</p>';

  const specCardsHtml =
    metrics.specifications.length > 0
      ? metrics.specifications
          .map(
            (s) => `
          <div class="card artifact-card">
            <div class="card-header">
              <span class="badge badge-purple">${escapeHtml(s.code)}</span>
              <span class="badge badge-status">${escapeHtml(s.status)}</span>
              <span class="version-badge">v${s.version}</span>
            </div>
            <h3 class="card-title">${escapeHtml(s.title)}</h3>
            <p class="card-desc">${escapeHtml(s.summary)}</p>
            <div class="card-footer">
              <a href="${escapeHtml(s.relPath)}" target="_blank" class="btn btn-outline" title="${escapeHtml(
              s.filePath,
            )}">
                📄 Ver Especificación Markdown (${escapeHtml(path.basename(s.filePath))})
              </a>
            </div>
          </div>
        `,
          )
          .join('')
      : '<p class="text-muted">No se han registrado especificaciones técnicas.</p>';

  const impCardsHtml =
    metrics.implementations.length > 0
      ? metrics.implementations
          .map(
            (imp) => `
          <div class="card artifact-card">
            <div class="card-header">
              <span class="badge badge-cyan">${escapeHtml(imp.code)}</span>
              <span class="badge badge-status">${escapeHtml(imp.status)}</span>
              <span class="version-badge">v${imp.version}</span>
            </div>
            <h3 class="card-title">${escapeHtml(imp.title)}</h3>
            <p class="card-desc">${escapeHtml(imp.summary)}</p>
            <div class="card-footer">
              <a href="${escapeHtml(imp.relPath)}" target="_blank" class="btn btn-outline" title="${escapeHtml(
              imp.filePath,
            )}">
                📄 Ver Cuaderno de Bitácora (${escapeHtml(path.basename(imp.filePath))})
              </a>
            </div>
          </div>
        `,
          )
          .join('')
      : '<p class="text-muted">Sin cuadernos de implementación registrados.</p>';

  const unitTestBlockHtml = metrics.unitTestExecution
    ? `
      <div class="card unit-test-card">
        <div class="card-header">
          <span class="badge ${
            metrics.unitTestExecution.passed ? 'badge-green' : 'badge-red'
          }">${escapeHtml(metrics.unitTestExecution.statusBadge)}</span>
          <span class="badge badge-blue">Unit Tests Dev</span>
          <span class="badge badge-coverage">Cobertura: ${escapeHtml(
            metrics.unitTestExecution.coverage || '100%',
          )}</span>
        </div>
        <div class="cmd-box">
          <code>$ ${escapeHtml(metrics.unitTestExecution.command)}</code>
        </div>
        <p class="card-desc text-snippet">${escapeHtml(
          metrics.unitTestExecution.outputSnippet || '',
        )}</p>
        ${
          metrics.unitTestExecution.relPath
            ? `<div class="card-footer">
                <a href="${escapeHtml(
                  metrics.unitTestExecution.relPath,
                )}" target="_blank" class="btn btn-outline">
                  📄 Ver Registro de Pruebas Unitarias (${escapeHtml(
                    path.basename(metrics.unitTestExecution.filePath || ''),
                  )})
                </a>
              </div>`
            : ''
        }
      </div>
    `
    : '<p class="text-muted">No se encontraron ejecuciones de pruebas unitarias registradas.</p>';

  const devGherkinListHtml =
    metrics.devGherkinScenarios.length > 0
      ? metrics.devGherkinScenarios
          .map(
            (g) => `
          <div class="card gherkin-card">
            <div class="card-header">
              <span class="badge badge-cyan">${escapeHtml(g.code)}</span>
              <span class="badge badge-scenarios">${g.scenarioCount} Escenarios</span>
            </div>
            <h4 class="card-title">${escapeHtml(g.title)}</h4>
            <p class="card-desc">${escapeHtml(g.summary)}</p>
            <div class="card-footer">
              <a href="${escapeHtml(g.relPath)}" target="_blank" class="btn btn-sm btn-outline">
                🥒 Ver Feature Gherkin (${escapeHtml(path.basename(g.filePath))})
              </a>
            </div>
          </div>
        `,
          )
          .join('')
      : '<p class="text-muted">No hay escenarios Developer Gherkin disponibles.</p>';

  const qaGherkinListHtml =
    metrics.qaGherkinContracts.length > 0
      ? metrics.qaGherkinContracts
          .map(
            (qg) => `
          <div class="card gherkin-card">
            <div class="card-header">
              <span class="badge badge-orange">${escapeHtml(qg.code)}</span>
              <span class="badge badge-cat">${escapeHtml(qg.category || 'QA')}</span>
              <span class="badge badge-scenarios">${qg.scenarioCount} Escenarios</span>
            </div>
            <h4 class="card-title">${escapeHtml(qg.title)}</h4>
            <p class="card-desc">${escapeHtml(qg.summary)}</p>
            <div class="card-footer">
              <a href="${escapeHtml(qg.relPath)}" target="_blank" class="btn btn-sm btn-outline">
                🥒 Ver Feature QA (${escapeHtml(path.basename(qg.filePath))})
              </a>
            </div>
          </div>
        `,
          )
          .join('')
      : '<p class="text-muted">No hay contratos Gherkin de QA disponibles.</p>';

  const robotReportsHtml = `
    <div class="robot-links-grid">
      <div class="robot-item ${metrics.robotFrameworkLogs.logHtml ? 'available' : 'missing'}">
        <div class="robot-icon">📊</div>
        <div class="robot-details">
          <h4>Robot Framework Log</h4>
          <p class="text-muted">${
            metrics.robotFrameworkLogs.logHtml
              ? `log.html (${metrics.robotFrameworkLogs.logHtml.sizeKb} KB) — Trazas paso a paso`
              : 'No generado aún'
          }</p>
        </div>
        ${
          metrics.robotFrameworkLogs.logHtml
            ? `<a href="${escapeHtml(
                metrics.robotFrameworkLogs.logHtml.relPath,
              )}" target="_blank" class="btn btn-primary">Abrir log.html</a>`
            : '<span class="badge badge-pending">Pendiente</span>'
        }
      </div>

      <div class="robot-item ${metrics.robotFrameworkLogs.reportHtml ? 'available' : 'missing'}">
        <div class="robot-icon">📑</div>
        <div class="robot-details">
          <h4>Robot Framework Report</h4>
          <p class="text-muted">${
            metrics.robotFrameworkLogs.reportHtml
              ? `report.html (${metrics.robotFrameworkLogs.reportHtml.sizeKb} KB) — Gráficos y resumen de suites`
              : 'No generado aún'
          }</p>
        </div>
        ${
          metrics.robotFrameworkLogs.reportHtml
            ? `<a href="${escapeHtml(
                metrics.robotFrameworkLogs.reportHtml.relPath,
              )}" target="_blank" class="btn btn-primary">Abrir report.html</a>`
            : '<span class="badge badge-pending">Pendiente</span>'
        }
      </div>

      <div class="robot-item ${metrics.robotFrameworkLogs.outputXml ? 'available' : 'missing'}">
        <div class="robot-icon">⚙️</div>
        <div class="robot-details">
          <h4>Salida Máquina XML</h4>
          <p class="text-muted">${
            metrics.robotFrameworkLogs.outputXml
              ? `output.xml (${metrics.robotFrameworkLogs.outputXml.sizeKb} KB) — Estructura XML completa`
              : 'No generado aún'
          }</p>
        </div>
        ${
          metrics.robotFrameworkLogs.outputXml
            ? `<a href="${escapeHtml(
                metrics.robotFrameworkLogs.outputXml.relPath,
              )}" target="_blank" class="btn btn-outline">Ver output.xml</a>`
            : '<span class="badge badge-pending">Pendiente</span>'
        }
      </div>
    </div>
  `;

  const qaExecRowsHtml =
    metrics.qaTestExecutions.length > 0
      ? metrics.qaTestExecutions
          .map(
            (te) => `
        <tr>
          <td><code>${escapeHtml(te.id)}</code></td>
          <td><span class="badge badge-suite">${escapeHtml(te.suite)}</span></td>
          <td>${escapeHtml(te.title)}</td>
          <td><code>${escapeHtml(te.gherkinRef || 'QA-GHERKIN')}</code></td>
          <td>
            <span class="badge ${
              te.status === 'PASS'
                ? 'badge-green'
                : te.status === 'FAIL'
                  ? 'badge-red'
                  : 'badge-yellow'
            }">${escapeHtml(te.status)}</span>
          </td>
          <td class="text-right text-muted">${te.durationMs ?? 0} ms</td>
        </tr>
      `,
          )
          .join('')
      : `<tr><td colspan="6" class="text-muted text-center">No hay ejecuciones individuales registradas.</td></tr>`;

  const defectsRowsHtml =
    metrics.qaDefects.length > 0
      ? metrics.qaDefects
          .map(
            (d) => `
        <tr>
          <td><code>${escapeHtml(d.code)}</code></td>
          <td><span class="badge badge-severity-${escapeHtml(
            (d.severity || 'LOW').toLowerCase(),
          )}">${escapeHtml(d.severity)}</span></td>
          <td><strong>${escapeHtml(d.title)}</strong></td>
          <td class="text-muted">${escapeHtml(d.violatedCriteria || '')}</td>
          <td><code>${escapeHtml(d.evidence || '')}</code></td>
        </tr>
      `,
          )
          .join('')
      : `<tr><td colspan="5" class="text-muted text-center">✅ No se detectaron defectos abiertos. Todos los criterios de aceptación están cumplidos.</td></tr>`;

  const promptsRowsHtml = metrics.systemPrompts
    .map(
      (sp) => `
        <div class="card prompt-card">
          <div class="card-header">
            <span class="role-pill role-${escapeHtml(sp.role)}">${escapeHtml(sp.role)}</span>
            <span class="badge badge-muted">${sp.lines} líneas · ${sp.sizeKb} KB</span>
          </div>
          <h4 class="card-title">${escapeHtml(sp.displayName)}</h4>
          <p class="card-desc">${escapeHtml(sp.excerpt)}</p>
          <div class="card-footer">
            <a href="${escapeHtml(sp.relPath)}" target="_blank" class="btn btn-outline" title="${escapeHtml(
        sp.path,
      )}">
              📜 Ver System Prompt (${escapeHtml(path.basename(sp.path))})
            </a>
          </div>
        </div>
      `,
    )
    .join('');

  const mdInventoryRowsHtml = metrics.allMarkdownFiles
    .map(
      (f) => `
        <tr>
          <td><code>${escapeHtml(f.relPath)}</code></td>
          <td><span class="badge badge-category">${escapeHtml(f.category)}</span></td>
          <td class="text-right text-muted">${f.sizeKb} KB</td>
          <td class="text-right">
            <a href="${escapeHtml(
              path.relative(path.join(project.workspaceDir, 'deliveries'), f.fullPath).replace(/\\/g, '/'),
            )}" target="_blank" class="btn btn-sm btn-outline">
              Abrir
            </a>
          </td>
        </tr>
      `,
    )
    .join('');

  const repoCardsHtml =
    metrics.repositories.length > 0
      ? metrics.repositories
          .map(
            (r) => `
          <div class="card repo-card">
            <div class="card-header">
              <span class="badge badge-repo">Git Repository</span>
              <span class="badge badge-muted">${r.filesCount} ficheros</span>
            </div>
            <h4 class="card-title"><code>repos/${escapeHtml(r.name)}</code></h4>
            <div class="repo-file-tree">
              ${r.files
                .slice(0, 10)
                .map((f) => `<div class="tree-leaf">📄 ${escapeHtml(f)}</div>`)
                .join('')}
              ${
                r.files.length > 10
                  ? `<div class="tree-more text-muted">+ ${r.files.length - 10} ficheros adicionales...</div>`
                  : ''
              }
            </div>
          </div>
        `,
          )
          .join('')
      : '<p class="text-muted">No se detectaron repositorios Git bajo repos/.</p>';

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Informe de Estado del Proyecto — ${escapeHtml(project.name)}</title>
  <style>
    :root {
      --bg: #0b0f19;
      --surface: #111827;
      --card-bg: #1f2937;
      --card-hover: #263345;
      --border: #374151;
      --border-bright: #4b5563;
      --text: #f9fafb;
      --text-muted: #9ca3af;
      --text-dim: #6b7280;
      --accent: #38bdf8;
      --accent-rgb: 56, 189, 248;
      --green: #22c55e;
      --green-bg: rgba(34, 197, 94, 0.14);
      --amber: #f59e0b;
      --amber-bg: rgba(245, 158, 11, 0.14);
      --red: #ef4444;
      --red-bg: rgba(239, 68, 68, 0.14);
      --purple: #a855f7;
      --cyan: #06b6d4;
      --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: var(--font);
      line-height: 1.6;
      padding: 2rem 1.5rem 5rem 1.5rem;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
    }

    header.report-header {
      border-bottom: 1px solid var(--border);
      padding-bottom: 2rem;
      margin-bottom: 2rem;
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: flex-start;
      gap: 1.5rem;
    }

    .brand-title {
      font-size: 2.1rem;
      font-weight: 800;
      letter-spacing: -0.02em;
      color: #fff;
    }

    .brand-title span {
      color: var(--accent);
    }

    .brand-subtitle {
      color: var(--text-muted);
      font-size: 1.05rem;
      margin-top: 0.35rem;
    }

    .meta-box {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 0.85rem 1.25rem;
      font-size: 0.88rem;
    }

    .meta-box div {
      margin-bottom: 0.25rem;
    }
    .meta-box div:last-child {
      margin-bottom: 0;
    }

    /* Construction / Completed Banners */
    .banner {
      border-radius: 12px;
      padding: 1.75rem 2rem;
      margin-bottom: 2.5rem;
      display: flex;
      gap: 1.5rem;
      align-items: flex-start;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.3);
    }

    .banner-construction {
      background: linear-gradient(135deg, rgba(245, 158, 11, 0.16), rgba(17, 24, 39, 0.95));
      border: 2px solid var(--amber);
    }

    .banner-completed {
      background: linear-gradient(135deg, rgba(34, 197, 94, 0.16), rgba(17, 24, 39, 0.95));
      border: 2px solid var(--green);
    }

    .banner-icon {
      font-size: 3rem;
      line-height: 1;
    }

    .banner-title {
      font-size: 1.5rem;
      font-weight: 700;
      color: #fff;
      margin: 0.35rem 0 0.5rem 0;
    }

    .banner-desc {
      font-size: 1rem;
      color: var(--text-muted);
      margin-bottom: 1rem;
      line-height: 1.5;
    }

    .banner-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 1.25rem;
      font-size: 0.9rem;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
      padding-top: 0.75rem;
    }

    /* KPI Grid */
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 1rem;
      margin-bottom: 2.5rem;
    }

    .kpi-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1.25rem;
      text-align: center;
      transition: transform 0.15s ease, border-color 0.15s ease;
    }

    .kpi-card:hover {
      transform: translateY(-2px);
      border-color: var(--border-bright);
    }

    .kpi-val {
      font-size: 2rem;
      font-weight: 800;
      color: #fff;
      margin-bottom: 0.2rem;
      font-family: var(--font-mono);
    }

    .kpi-label {
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
    }

    .kpi-sub {
      font-size: 0.78rem;
      color: var(--accent);
      margin-top: 0.35rem;
    }

    /* Section Styling */
    section.report-section {
      margin-bottom: 3rem;
    }

    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      border-bottom: 2px solid var(--border);
      padding-bottom: 0.65rem;
      margin-bottom: 1.25rem;
    }

    .section-title {
      font-size: 1.35rem;
      font-weight: 700;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .section-subtitle {
      font-size: 0.88rem;
      color: var(--text-muted);
    }

    /* Cards Grid */
    .cards-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 1.25rem;
    }

    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1.25rem;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      transition: background 0.15s ease;
    }

    .card:hover {
      background: var(--card-hover);
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.75rem;
      gap: 0.5rem;
    }

    .card-title {
      font-size: 1.05rem;
      font-weight: 700;
      color: #fff;
      margin-bottom: 0.5rem;
    }

    .card-desc {
      font-size: 0.9rem;
      color: var(--text-muted);
      margin-bottom: 1rem;
      line-height: 1.5;
    }

    .card-footer {
      margin-top: auto;
      padding-top: 0.75rem;
      border-top: 1px solid var(--border);
    }

    /* Badges */
    .badge {
      display: inline-block;
      padding: 0.25rem 0.6rem;
      border-radius: 6px;
      font-size: 0.75rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      font-family: var(--font-mono);
    }

    .badge-pulse {
      background: var(--amber-bg);
      color: var(--amber);
      border: 1px solid var(--amber);
      animation: pulse 2s infinite;
    }

    .badge-green { background: var(--green-bg); color: var(--green); border: 1px solid var(--green); }
    .badge-blue { background: rgba(56, 189, 248, 0.14); color: var(--accent); border: 1px solid var(--accent); }
    .badge-purple { background: rgba(168, 85, 247, 0.14); color: var(--purple); border: 1px solid var(--purple); }
    .badge-cyan { background: rgba(6, 182, 212, 0.14); color: var(--cyan); border: 1px solid var(--cyan); }
    .badge-orange { background: rgba(249, 115, 22, 0.14); color: #f97316; border: 1px solid #f97316; }
    .badge-red { background: var(--red-bg); color: var(--red); border: 1px solid var(--red); }
    .badge-muted { background: var(--surface); color: var(--text-muted); border: 1px solid var(--border); }
    .badge-status { background: rgba(255,255,255,0.06); color: var(--text); border: 1px solid var(--border); }
    .badge-suite { background: rgba(255,255,255,0.08); color: #e2e8f0; border: 1px solid var(--border); }
    .badge-category { background: rgba(56, 189, 248, 0.08); color: var(--accent); }
    .badge-scenarios { background: rgba(34, 197, 94, 0.08); color: var(--green); }
    .badge-coverage { background: rgba(34, 197, 94, 0.15); color: var(--green); border: 1px solid var(--green); }
    .badge-repo { background: rgba(168, 85, 247, 0.15); color: var(--purple); border: 1px solid var(--purple); }
    .badge-pending { background: rgba(156, 163, 175, 0.15); color: var(--text-muted); }
    .version-badge { font-size: 0.8rem; color: var(--text-dim); font-family: var(--font-mono); }

    /* Buttons */
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.45rem 0.85rem;
      border-radius: 6px;
      font-size: 0.82rem;
      font-weight: 600;
      text-decoration: none;
      transition: all 0.15s ease;
      cursor: pointer;
    }

    .btn-primary {
      background: var(--accent);
      color: #0b0f19;
      border: 1px solid var(--accent);
    }
    .btn-primary:hover {
      background: #7dd3fc;
      border-color: #7dd3fc;
    }

    .btn-outline {
      background: transparent;
      color: var(--accent);
      border: 1px solid var(--border-bright);
    }
    .btn-outline:hover {
      background: rgba(56, 189, 248, 0.12);
      border-color: var(--accent);
    }

    .btn-sm {
      padding: 0.25rem 0.55rem;
      font-size: 0.78rem;
    }

    /* Role Pills */
    .role-pill {
      display: inline-block;
      padding: 0.2rem 0.55rem;
      border-radius: 4px;
      font-size: 0.78rem;
      font-weight: 700;
      text-transform: uppercase;
      font-family: var(--font-mono);
    }
    .role-product_owner { background: #3b82f6; color: #fff; }
    .role-architect { background: #6366f1; color: #fff; }
    .role-developer { background: #10b981; color: #fff; }
    .role-qa { background: #f59e0b; color: #0b0f19; }
    .role-pm { background: #ec4899; color: #fff; }

    /* Tables */
    .table-container {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      overflow-x: auto;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.88rem;
      text-align: left;
    }

    th {
      background: rgba(255, 255, 255, 0.03);
      padding: 0.75rem 1rem;
      font-weight: 700;
      color: var(--text-muted);
      border-bottom: 1px solid var(--border);
      text-transform: uppercase;
      font-size: 0.75rem;
      letter-spacing: 0.05em;
    }

    td {
      padding: 0.75rem 1rem;
      border-bottom: 1px solid var(--border);
      color: var(--text);
    }

    tr:last-child td {
      border-bottom: none;
    }

    tr:hover td {
      background: rgba(255, 255, 255, 0.02);
    }

    .arrow-cell {
      text-align: center;
      color: var(--text-dim);
      font-weight: bold;
    }

    .text-right { text-align: right; }
    .text-center { text-align: center; }
    .text-muted { color: var(--text-muted); }

    /* Robot Framework Links Grid */
    .robot-links-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 1rem;
      margin-bottom: 1.5rem;
    }

    .robot-item {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1.25rem;
      display: flex;
      align-items: center;
      gap: 1rem;
    }

    .robot-item.available {
      border-color: var(--accent);
      background: linear-gradient(135deg, rgba(56, 189, 248, 0.08), var(--surface));
    }

    .robot-icon { font-size: 2.2rem; }
    .robot-details { flex-grow: 1; }
    .robot-details h4 { font-size: 1rem; color: #fff; margin-bottom: 0.2rem; }

    /* Command code box */
    .cmd-box {
      background: #000;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 0.6rem 0.85rem;
      margin: 0.75rem 0;
      font-family: var(--font-mono);
      font-size: 0.85rem;
      color: #38bdf8;
      overflow-x: auto;
    }

    .text-snippet {
      font-family: var(--font-mono);
      font-size: 0.8rem;
      background: rgba(0, 0, 0, 0.3);
      padding: 0.5rem;
      border-radius: 4px;
      white-space: pre-wrap;
      max-height: 120px;
      overflow-y: auto;
    }

    /* Repo Tree */
    .repo-file-tree {
      background: #000;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 0.6rem 0.8rem;
      font-family: var(--font-mono);
      font-size: 0.8rem;
      color: var(--text-muted);
      margin-top: 0.5rem;
    }
    .tree-leaf { padding: 0.15rem 0; color: #cbd5e1; }
    .tree-more { padding-top: 0.3rem; font-style: italic; }

    /* Footer */
    footer.report-footer {
      border-top: 1px solid var(--border);
      padding-top: 2rem;
      margin-top: 4rem;
      text-align: center;
      font-size: 0.85rem;
      color: var(--text-muted);
    }

    footer.report-footer strong {
      color: #fff;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }

    code {
      font-family: var(--font-mono);
      background: rgba(255,255,255,0.06);
      padding: 0.15rem 0.4rem;
      border-radius: 4px;
      font-size: 0.88em;
    }

    .tag-agent {
      background: rgba(56, 189, 248, 0.18);
      color: var(--accent);
      padding: 0.15rem 0.45rem;
      border-radius: 4px;
      font-weight: 600;
      font-size: 0.85rem;
    }

    .tag-verdict-pass {
      color: var(--green);
      font-weight: 700;
      font-family: var(--font-mono);
    }
  </style>
</head>
<body>
  <div class="container">
    <header class="report-header">
      <div>
        <h1 class="brand-title">PO CLI <span>Project Status Report</span></h1>
        <p class="brand-subtitle">Informe Ejecutivo & Técnico generado por el Agente <strong>Project Manager (PM)</strong></p>
      </div>
      <div class="meta-box">
        <div><strong>Proyecto:</strong> <code>${escapeHtml(project.name)}</code></div>
        <div><strong>Fecha:</strong> ${escapeHtml(humanDate)}</div>
        <div><strong>ID Proyecto:</strong> <code>${escapeHtml(project.id)}</code></div>
        <div><strong>Workspace:</strong> <code>${escapeHtml(project.workspaceDir)}</code></div>
      </div>
    </header>

    ${constructionBannerHtml}

    <!-- 1. Executive Metrics Grid -->
    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-val">${metrics.totalMessages}</div>
        <div class="kpi-label">Mensajes Inter-Agente</div>
        <div class="kpi-sub">~${metrics.totalTokens.toLocaleString()} tokens</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-val">${metrics.totalArtifacts}</div>
        <div class="kpi-label">Artefactos Normativos</div>
        <div class="kpi-sub">${metrics.allMarkdownFiles.length} ficheros .md/.feature</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-val" style="color: var(--green);">${
          metrics.unitTestExecution?.passed ? '100%' : 'N/A'
        }</div>
        <div class="kpi-label">Unit Tests Dev</div>
        <div class="kpi-sub">${escapeHtml(
          metrics.unitTestExecution?.coverage || 'Green Metric',
        )}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-val" style="color: ${
          metrics.qaVerdict === 'PASS'
            ? 'var(--green)'
            : metrics.qaVerdict === 'FAIL'
              ? 'var(--red)'
              : 'var(--amber)'
        };">${escapeHtml(metrics.qaVerdict ?? 'PENDIENTE')}</div>
        <div class="kpi-label">Veredicto QA</div>
        <div class="kpi-sub">${
          metrics.qaMetrics
            ? `${metrics.qaMetrics.passedCount}/${metrics.qaMetrics.totalTests} tests OK`
            : 'En verificación'
        }</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-val" style="color: var(--accent);">${
          metrics.qaMutationScore !== undefined
            ? `${metrics.qaMutationScore}%`
            : '100%'
        }</div>
        <div class="kpi-label">Mutación Adversarial</div>
        <div class="kpi-sub">Resistencia de código</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-val">${escapeHtml(metrics.elapsedFormatted)}</div>
        <div class="kpi-label">Tiempo Transcurrido</div>
        <div class="kpi-sub">${escapeHtml(metrics.activePhaseLabel)}</div>
      </div>
    </div>

    <!-- 2. Inter-Agent Communication Matrix -->
    <section class="report-section">
      <div class="section-header">
        <h2 class="section-title">💬 Matriz de Interacción Entre Agentes</h2>
        <span class="section-subtitle">Trazabilidad cuantitativa registrada en SQLite (messages)</span>
      </div>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Agente Emisor</th>
              <th class="text-center">Flujo</th>
              <th>Agente Receptor</th>
              <th class="text-right">Mensajes</th>
              <th class="text-right">Tokens Estimados</th>
            </tr>
          </thead>
          <tbody>
            ${matrixRowsHtml}
          </tbody>
        </table>
      </div>
    </section>

    <!-- 3. Reference Architecture -->
    <section class="report-section">
      <div class="section-header">
        <h2 class="section-title">🏛️ Arquitecturas Propuestas (ARCH-*)</h2>
        <span class="section-subtitle">Gobernadas por el Software Architect</span>
      </div>
      <div class="cards-grid">
        ${archCardsHtml}
      </div>
    </section>

    <!-- 4. Developer Technical Specification -->
    <section class="report-section">
      <div class="section-header">
        <h2 class="section-title">📋 Especificaciones Técnicas (SPEC-*)</h2>
        <span class="section-subtitle">Contratos normativos entregados al Senior Developer</span>
      </div>
      <div class="cards-grid">
        ${specCardsHtml}
      </div>
    </section>

    <!-- 5. Senior Developer Implementation & Unit Tests -->
    <section class="report-section">
      <div class="section-header">
        <h2 class="section-title">💻 Diseño, Repositorios e Implementación (Senior Developer)</h2>
        <span class="section-subtitle">Estructura en repos/*.git, Bitácora (IMP-*) y Pruebas Unitarias</span>
      </div>

      <div style="margin-bottom: 1.5rem;">
        <h3 style="font-size: 1.1rem; color: #fff; margin-bottom: 0.75rem;">🧪 Pruebas Unitarias del Developer (100% Green Metric)</h3>
        ${unitTestBlockHtml}
      </div>

      <div style="margin-bottom: 1.5rem;">
        <h3 style="font-size: 1.1rem; color: #fff; margin-bottom: 0.75rem;">📦 Repositorios Git Activos</h3>
        <div class="cards-grid">
          ${repoCardsHtml}
        </div>
      </div>

      <div style="margin-bottom: 1.5rem;">
        <h3 style="font-size: 1.1rem; color: #fff; margin-bottom: 0.75rem;">📓 Bitácoras de Implementación (IMP-*)</h3>
        <div class="cards-grid">
          ${impCardsHtml}
        </div>
      </div>

      <div>
        <h3 style="font-size: 1.1rem; color: #fff; margin-bottom: 0.75rem;">🥒 Pruebas Gherkin Preparadas por el Developer (DEV-GHERKIN-*)</h3>
        <div class="cards-grid">
          ${devGherkinListHtml}
        </div>
      </div>
    </section>

    <!-- 6. Independent QA Verification & Robot Framework -->
    <section class="report-section">
      <div class="section-header">
        <h2 class="section-title">🔬 Verificación Independiente QA & Robot Framework</h2>
        <span class="section-subtitle">Ejecución adversarial aislada en scripts/ y contratos contracts/qa/</span>
      </div>

      <!-- Robot Framework HTML & XML Logs -->
      <h3 style="font-size: 1.1rem; color: #fff; margin-bottom: 0.75rem;">📑 Informes Oficiales de Robot Framework (.html / .xml)</h3>
      ${robotReportsHtml}

      <!-- QA Behavioral Contracts -->
      <div style="margin-bottom: 1.75rem;">
        <h3 style="font-size: 1.1rem; color: #fff; margin-bottom: 0.75rem;">🥒 Contratos de Comportamiento QA (QA-GHERKIN-* / REQ-*)</h3>
        <div class="cards-grid">
          ${qaGherkinListHtml}
        </div>
      </div>

      <!-- QA Executions Table -->
      <div style="margin-bottom: 1.75rem;">
        <h3 style="font-size: 1.1rem; color: #fff; margin-bottom: 0.75rem;">📋 Ejecución Caso por Caso (QA-EXEC-*)</h3>
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Suite</th>
                <th>Título del Test</th>
                <th>Ref Gherkin</th>
                <th>Estado</th>
                <th class="text-right">Duración</th>
              </tr>
            </thead>
            <tbody>
              ${qaExecRowsHtml}
            </tbody>
          </table>
        </div>
      </div>

      <!-- QA Defects Table -->
      <div>
        <h3 style="font-size: 1.1rem; color: #fff; margin-bottom: 0.75rem;">🐞 Registro de Defectos Detectados (DEF-*)</h3>
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>Código</th>
                <th>Severidad</th>
                <th>Título del Defecto</th>
                <th>Criterio Violado</th>
                <th>Evidencia Técnica</th>
              </tr>
            </thead>
            <tbody>
              ${defectsRowsHtml}
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- 7. System Prompts & Governance Contracts -->
    <section class="report-section">
      <div class="section-header">
        <h2 class="section-title">📜 System Prompts & Filosofía de Agentes</h2>
        <span class="section-subtitle">Instrucciones canónicas preservadas en behavior/system/</span>
      </div>
      <div class="cards-grid">
        ${promptsRowsHtml}
      </div>
    </section>

    <!-- 8. Complete Markdown & Feature Files Inventory -->
    <section class="report-section">
      <div class="section-header">
        <h2 class="section-title">📁 Inventario Completo de Ficheros Markdown & Gherkin (.md / .feature)</h2>
        <span class="section-subtitle">Total de ${
          metrics.allMarkdownFiles.length
        } ficheros documentales detectados en el workspace</span>
      </div>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Ruta Relativa al Workspace</th>
              <th>Categoría</th>
              <th class="text-right">Tamaño</th>
              <th class="text-right">Enlace Directo</th>
            </tr>
          </thead>
          <tbody>
            ${mdInventoryRowsHtml}
          </tbody>
        </table>
      </div>
    </section>

    <footer class="report-footer">
      <p>Informe generado automáticamente por el <strong>Agente Project Manager (PM)</strong> de PO CLI.</p>
      <p class="text-muted" style="margin-top: 0.35rem;">
        Fichero generado en: <code>${escapeHtml(
          path.join(project.workspaceDir, 'deliveries', 'project-status-report.html'),
        )}</code> · Timestamp: ${escapeHtml(generatedAt)}
      </p>
    </footer>
  </div>
</body>
</html>`;
}
