import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import React from 'react';
import { PoCliDatabase } from '../src/storage/database.js';
import { PoCliOrchestrator } from '../src/runtime/orchestrator.js';
import { CommandCenterApp } from '../src/tui/CommandCenterApp.js';

describe('No Default Workspace / No Initial Project Behavior', () => {
  let tempDir: string;
  let storage: PoCliDatabase;
  let orchestrator: PoCliOrchestrator;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocli-nodefault-'));
    storage = new PoCliDatabase(path.join(tempDir, 'pocli.sqlite'));
    orchestrator = new PoCliOrchestrator(storage);
  });

  afterEach(() => {
    try {
      storage.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('initializes with zero projects and getActiveProject() returns null', () => {
    expect(storage.listProjects()).toHaveLength(0);
    expect(storage.getActiveProject()).toBeNull();
  });

  it('does not create any default-workspace folder in workspaces directory', () => {
    storage.ensureWorkDirStructure(tempDir);
    const workspacesDir = path.join(tempDir, 'workspaces');
    expect(fs.existsSync(workspacesDir)).toBe(true);

    const contents = fs.readdirSync(workspacesDir);
    expect(contents).not.toContain('default-workspace');
    expect(contents).toHaveLength(0);
  });

  it('allows CommandCenterApp to be instantiated with initialProject: null', () => {
    const element = React.createElement(CommandCenterApp, {
      orchestrator,
      initialProject: null,
    });
    expect(element).toBeDefined();
    expect(element.props.initialProject).toBeNull();
  });

  it('returns null active project after creating and then deleting a project', () => {
    const ws = path.join(tempDir, 'workspaces', 'temp-p1');
    fs.mkdirSync(ws, { recursive: true });

    const p = storage.createProject({
      name: 'temp-p1',
      description: 'temp',
      workspaceDir: ws,
    });

    expect(storage.getActiveProject()?.id).toBe(p.id);

    orchestrator.deleteProject(p.id);
    expect(storage.getActiveProject()).toBeNull();
    expect(storage.listProjects()).toHaveLength(0);
  });
});
