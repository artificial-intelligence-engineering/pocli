import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PoCliDatabase } from '../src/storage/database.js';
import { PoCliOrchestrator } from '../src/runtime/orchestrator.js';

describe('Issue #38 — Project Deletion and Archival (DELETED_<name>)', () => {
  let tempDir: string;
  let storage: PoCliDatabase;
  let orchestrator: PoCliOrchestrator;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocli-del-test-'));
    storage = new PoCliDatabase(path.join(tempDir, 'pocli.sqlite'));
    orchestrator = new PoCliOrchestrator(storage);
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('deletes project from database and renames workspace folder to DELETED_<name>', () => {
    const wsDir = path.join(tempDir, 'workspaces', 'alpha-proj');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'README.md'), '# Alpha Project');

    const proj = storage.createProject({
      name: 'alpha-proj',
      description: 'Alpha test project',
      workspaceDir: wsDir,
    });

    // Create an artifact for the project
    storage.saveArtifact({
      projectId: proj.id,
      code: 'REQ-001',
      type: 'REQUIREMENT',
      title: 'Initial Requirement',
      content: 'Must run securely',
      authorRole: 'product_owner',
      status: 'APPROVED',
    });

    expect(storage.getProject(proj.id)).not.toBeNull();
    expect(storage.listArtifacts(proj.id).length).toBe(1);

    // Delete project
    const { renamedWorkspaceDir } = orchestrator.deleteProject(proj.id);

    // 1. Filesystem check: old workspace should be gone, renamed to DELETED_alpha-proj
    expect(fs.existsSync(wsDir)).toBe(false);
    expect(renamedWorkspaceDir).toBeDefined();
    expect(fs.existsSync(renamedWorkspaceDir!)).toBe(true);
    expect(path.basename(renamedWorkspaceDir!)).toBe('DELETED_alpha-proj');
    expect(
      fs.readFileSync(path.join(renamedWorkspaceDir!, 'README.md'), 'utf8'),
    ).toBe('# Alpha Project');

    // 2. Database check: project and associated artifacts are purged
    expect(storage.getProject(proj.id)).toBeNull();
    expect(storage.listArtifacts(proj.id).length).toBe(0);
    expect(storage.listProjects().find((p) => p.id === proj.id)).toBeUndefined();
  });

  it('excludes any projects with name starting with DELETED_ from listProjects()', () => {
    const ws1 = path.join(tempDir, 'ws1');
    const ws2 = path.join(tempDir, 'ws2');
    fs.mkdirSync(ws1, { recursive: true });
    fs.mkdirSync(ws2, { recursive: true });

    storage.createProject({
      name: 'active-project',
      description: 'Visible project',
      workspaceDir: ws1,
    });

    storage.createProject({
      name: 'DELETED_archived-project',
      description: 'Archived project',
      workspaceDir: ws2,
    });

    const listed = storage.listProjects();
    expect(listed.some((p) => p.name === 'active-project')).toBe(true);
    expect(listed.some((p) => p.name.startsWith('DELETED_'))).toBe(false);
  });

  it('updates activeProjectId to a remaining project when the active project is deleted', () => {
    const wsA = path.join(tempDir, 'wsA');
    const wsB = path.join(tempDir, 'wsB');
    fs.mkdirSync(wsA, { recursive: true });
    fs.mkdirSync(wsB, { recursive: true });

    const projA = storage.createProject({
      name: 'Project A',
      description: 'Desc A',
      workspaceDir: wsA,
    });

    const projB = storage.createProject({
      name: 'Project B',
      description: 'Desc B',
      workspaceDir: wsB,
    });

    // Make projA active
    storage.updateSettings({ activeProjectId: projA.id });
    expect(storage.getSettings().activeProjectId).toBe(projA.id);

    // Delete active project A
    const { newActiveProjectId } = storage.deleteProject(projA.id);

    expect(newActiveProjectId).toBe(projB.id);
    expect(storage.getSettings().activeProjectId).toBe(projB.id);
    expect(storage.listProjects().map((p) => p.id)).toEqual([projB.id]);
  });

  it('handles name collision gracefully if DELETED_<name> already exists', () => {
    const ws = path.join(tempDir, 'workspaces', 'beta-proj');
    const existingDeleted = path.join(tempDir, 'workspaces', 'DELETED_beta-proj');
    fs.mkdirSync(ws, { recursive: true });
    fs.mkdirSync(existingDeleted, { recursive: true });
    fs.writeFileSync(path.join(existingDeleted, 'old.txt'), 'archived earlier');

    const proj = storage.createProject({
      name: 'beta-proj',
      description: 'Beta project',
      workspaceDir: ws,
    });

    const { renamedWorkspaceDir } = storage.deleteProject(proj.id);

    expect(renamedWorkspaceDir).toBeDefined();
    expect(fs.existsSync(existingDeleted)).toBe(true);
    expect(fs.existsSync(renamedWorkspaceDir!)).toBe(true);
    expect(renamedWorkspaceDir).not.toBe(existingDeleted);
    expect(path.basename(renamedWorkspaceDir!)).toContain('DELETED_beta-proj_');
  });

  it('throws an error when attempting to delete a non-existent project', () => {
    expect(() => storage.deleteProject('non-existent-id')).toThrow(
      'Project non-existent-id not found.',
    );
  });
});
