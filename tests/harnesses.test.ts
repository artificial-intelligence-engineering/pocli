import { describe, it, expect } from 'vitest';
import { HarnessRegistry } from '../src/runtime/harnesses.js';
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
});

