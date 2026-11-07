import { describe, it, expect } from 'vitest';
import {
  HarnessRegistry,
  buildRoleToolsInstruction,
} from '../src/runtime/harnesses.js';
import fs from 'node:fs';
import path from 'node:path';

describe('HarnessRegistry & Behavior System Prompts', () => {
  it('loads system prompts from behavior/system/*.md files', () => {
    const roles = ['architect', 'developer', 'qa', 'pm'] as const;

    for (const role of roles) {
      const harness = HarnessRegistry.getHarness(role);
      const filePath = path.join(process.cwd(), 'behavior', 'system', `${role}.md`);
      
      expect(fs.existsSync(filePath)).toBe(true);
      const expectedContent = fs.readFileSync(filePath, 'utf8').trim();
      
      expect(harness.systemPrompt.trim()).toBe(expectedContent);
    }
  });

  it('provides all 4 core harnesses with non-empty system prompts and tools', () => {
    const all = HarnessRegistry.listHarnesses();
    expect(all.length).toBeGreaterThanOrEqual(4);

    for (const h of all) {
      expect(h.systemPrompt.length).toBeGreaterThan(20);
      expect(h.allowedTools.length).toBeGreaterThan(0);
      expect(h.allowedArtifactTypes.length).toBeGreaterThan(0);
    }
  });

  it('inspects prompt resolutions and reports locations', () => {
    const resolutions = HarnessRegistry.inspectResolutions();
    expect(resolutions.length).toBe(4);

    for (const res of resolutions) {
      expect(['architect', 'developer', 'qa', 'pm']).toContain(res.role);
      expect(res.content.length).toBeGreaterThan(20);
      expect(res.statusLabel).toBeDefined();
      expect(['user_override', 'bundle', 'repo_default', 'cwd', 'fallback']).toContain(res.sourceType);
    }
  });

  it('verifies Software Architect instructions include programming languages, repo strategy, and filesystem paths', () => {
    const architectHarness = HarnessRegistry.getHarness('architect');
    const prompt = architectHarness.systemPrompt;

    // 1. Discuss and recommend programming language(s)
    expect(prompt).toMatch(/programming language\(s\)/i);
    expect(prompt).toMatch(/technology stack/i);

    // 2. Discuss monorepo vs multi-repo
    expect(prompt).toMatch(/single repository \(monorepo\) or multiple repositories \(multi-repo\)/i);

    // 3. Inquire filesystem location / existence for Developer creation
    expect(prompt).toMatch(/where the repository or repositories should reside in the filesystem/i);
    expect(prompt).toMatch(/creation and initialization will be performed by the Senior Developer/i);

    // 4. Include into Technical Specification (SPEC-*)
    expect(prompt).toMatch(/Technical Specification \(SPEC-\*\)/i);

    // 5. Enforce repos/ layout and .git extension
    expect(prompt).toMatch(/repos\//i);
    expect(prompt).toMatch(/\.git/i);
  });

  it('verifies Senior Developer instructions enforce repos/ layout and .git repository naming', () => {
    const devHarness = HarnessRegistry.getHarness('developer');
    const prompt = devHarness.systemPrompt;

    expect(prompt).toMatch(/repos\/<repo-name>\.git/i);
    expect(prompt).toMatch(/\.git\b/i);
    expect(prompt).toMatch(/write_source_file/i);
  });

  it('verifies Issue #76 — Developer Full Autonomous Implementation Mandate and git init in prompts', () => {
    const devHarness = HarnessRegistry.getHarness('developer');
    const prompt = devHarness.systemPrompt;

    expect(prompt).toMatch(/FULL AUTONOMOUS IMPLEMENTATION MANDATE/i);
    expect(prompt).toMatch(/git init/i);
    expect(prompt).toMatch(/init_repository/i);
    expect(prompt).toMatch(/run_unit_tests/i);

    const toolsInstruction = buildRoleToolsInstruction('developer');
    expect(toolsInstruction).toMatch(/init_repository/i);
    expect(toolsInstruction).toMatch(/Autonomous Full Implementation/i);
  });
});

