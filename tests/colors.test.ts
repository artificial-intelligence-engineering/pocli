import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { c, formatLogLineForTerminal, isColorSupported } from '../src/core/colors.js';

describe('ANSI Color Utility (src/core/colors.ts)', () => {
  const originalNoColor = process.env.NO_COLOR;
  const originalForceColor = process.env.FORCE_COLOR;

  beforeEach(() => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = '1';
  });

  afterEach(() => {
    if (originalNoColor !== undefined) {
      process.env.NO_COLOR = originalNoColor;
    } else {
      delete process.env.NO_COLOR;
    }

    if (originalForceColor !== undefined) {
      process.env.FORCE_COLOR = originalForceColor;
    } else {
      delete process.env.FORCE_COLOR;
    }
  });

  it('detects color support correctly with FORCE_COLOR and NO_COLOR', () => {
    process.env.FORCE_COLOR = '1';
    delete process.env.NO_COLOR;
    expect(isColorSupported()).toBe(true);

    process.env.NO_COLOR = '1';
    expect(isColorSupported()).toBe(false);
  });

  it('applies semantic ANSI colors when enabled', () => {
    process.env.FORCE_COLOR = '1';
    delete process.env.NO_COLOR;

    expect(c.green('CONFIGURED')).toBe('\x1b[32mCONFIGURED\x1b[39m');
    expect(c.greenBold('✔ [CONFIGURED]')).toBe('\x1b[1;32m✔ [CONFIGURED]\x1b[0m');
    expect(c.gray('✖ [NOT CONFIGURED]')).toBe('\x1b[90m✖ [NOT CONFIGURED]\x1b[39m');
    expect(c.cyanBold('HEADER')).toBe('\x1b[1;36mHEADER\x1b[0m');
    expect(c.yellow('[128k]')).toBe('\x1b[33m[128k]\x1b[39m');
  });

  it('strips/bypasses colors when NO_COLOR is active', () => {
    process.env.NO_COLOR = '1';

    expect(c.green('CONFIGURED')).toBe('CONFIGURED');
    expect(c.greenBold('✔ [CONFIGURED]')).toBe('✔ [CONFIGURED]');
    expect(c.gray('✖ [NOT CONFIGURED]')).toBe('✖ [NOT CONFIGURED]');
  });

  it('formats log lines with colored timestamp, level badges, and category', () => {
    process.env.FORCE_COLOR = '1';
    delete process.env.NO_COLOR;

    const rawInfo = '[2026-11-04T18:00:00.000Z] [INFO ] [ORCHESTRATOR] Worker started';
    const formattedInfo = formatLogLineForTerminal(rawInfo);

    // Timestamp in gray
    expect(formattedInfo).toContain('\x1b[90m[2026-11-04T18:00:00.000Z]\x1b[39m');
    // Level INFO in green
    expect(formattedInfo).toContain('\x1b[32m[INFO ]\x1b[39m');
    // Category in magenta
    expect(formattedInfo).toContain('\x1b[35m[ORCHESTRATOR]\x1b[39m');
    expect(formattedInfo).toContain('Worker started');

    const rawError = '[2026-11-04T18:00:01.000Z] [ERROR] [WORKER] Crash occurred';
    const formattedError = formatLogLineForTerminal(rawError);
    // Level ERROR in redBold
    expect(formattedError).toContain('\x1b[1;31m[ERROR]\x1b[0m');

    const rawWarn = '[2026-11-04T18:00:02.000Z] [WARN ] [LLM-ROUTER] Rate limit approaching';
    const formattedWarn = formatLogLineForTerminal(rawWarn);
    // Level WARN in yellowBold
    expect(formattedWarn).toContain('\x1b[1;33m[WARN ]\x1b[0m');
  });

  it('returns raw line unchanged when NO_COLOR is set', () => {
    process.env.NO_COLOR = '1';

    const raw = '[2026-11-04T18:00:00.000Z] [INFO ] [ORCHESTRATOR] Worker started';
    expect(formatLogLineForTerminal(raw)).toBe(raw);
  });
});
