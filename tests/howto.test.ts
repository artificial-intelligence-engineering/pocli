import { describe, it, expect } from 'vitest';
import {
  getHowtoSections,
  getHowtoRenderLines,
  wrapText,
} from '../src/tui/howtoContent.js';
import { I18N_DICTIONARY } from '../src/core/i18n.js';

describe('Feature #42 — /howto Workflow Guide Modal', () => {
  it('1. Provides comprehensive workflow guide sections in Spanish (es)', () => {
    const sections = getHowtoSections('es');
    expect(sections.length).toBeGreaterThanOrEqual(8);

    const badges = sections.map((s) => s.badge);
    expect(badges).toContain('[PO]');
    expect(badges).toContain('[1]');
    expect(badges).toContain('[2]');
    expect(badges).toContain('[3]');
    expect(badges).toContain('[4]');
    expect(badges).toContain('[5]');
    expect(badges).toContain('[6]');
    expect(badges).toContain('[PM]');
    expect(badges).toContain('[★]');

    // Check specific workflow content in Spanish
    const poSection = sections.find((s) => s.badge === '[PO]');
    expect(poSection?.title).toContain('PRODUCT OWNER');
    expect(poSection?.paragraphs?.[0]).toContain('Tú diriges un equipo');

    const step1 = sections.find((s) => s.badge === '[1]');
    expect(step1?.title).toContain('PASO 1');
    expect(step1?.bullets?.some((b) => b.command === '/project')).toBe(true);

    const step2 = sections.find((s) => s.badge === '[2]');
    expect(step2?.title).toContain('PASO 2');
    expect(step2?.bullets?.some((b) => b.command === '/propose')).toBe(true);

    const step3 = sections.find((s) => s.badge === '[3]');
    expect(step3?.title).toContain('PASO 3');
    expect(step3?.bullets?.some((b) => b.command === '/approve')).toBe(true);

    const step4 = sections.find((s) => s.badge === '[4]');
    expect(step4?.title).toContain('PASO 4');
    expect(step4?.bullets?.some((b) => b.command === '/implement')).toBe(true);

    const step5 = sections.find((s) => s.badge === '[5]');
    expect(step5?.title).toContain('PASO 5');
    expect(step5?.bullets?.some((b) => b.command === '/validate')).toBe(true);

    const step6 = sections.find((s) => s.badge === '[6]');
    expect(step6?.title).toContain('PASO 6');
    expect(step6?.paragraphs?.[0]).toContain('/accept');

    const shortcuts = sections.find((s) => s.badge === '[★]');
    expect(shortcuts?.title).toContain('ATAJOS');
    expect(shortcuts?.bullets?.some((b) => b.command?.includes('Tab'))).toBe(true);
  });

  it('2. Provides comprehensive workflow guide sections in English (en)', () => {
    const sections = getHowtoSections('en');
    expect(sections.length).toBeGreaterThanOrEqual(8);

    const badges = sections.map((s) => s.badge);
    expect(badges).toContain('[PO]');
    expect(badges).toContain('[1]');
    expect(badges).toContain('[2]');
    expect(badges).toContain('[3]');
    expect(badges).toContain('[4]');
    expect(badges).toContain('[5]');
    expect(badges).toContain('[6]');
    expect(badges).toContain('[PM]');
    expect(badges).toContain('[★]');

    const poSection = sections.find((s) => s.badge === '[PO]');
    expect(poSection?.title).toContain('PRODUCT OWNER');
    expect(poSection?.paragraphs?.[0]).toContain('Product Owner');

    const step1 = sections.find((s) => s.badge === '[1]');
    expect(step1?.title).toContain('STEP 1');
    expect(step1?.bullets?.some((b) => b.command === '/project')).toBe(true);

    const step2 = sections.find((s) => s.badge === '[2]');
    expect(step2?.title).toContain('STEP 2');
    expect(step2?.bullets?.some((b) => b.command === '/propose')).toBe(true);
  });

  it('3. Renders wrapped lines correctly for various widths', () => {
    const narrowLines = getHowtoRenderLines('es', 40);
    expect(narrowLines.length).toBeGreaterThan(40);

    const wideLines = getHowtoRenderLines('es', 100);
    expect(wideLines.length).toBeGreaterThan(25);
    // Narrow layout should wrap into more lines than wide layout
    expect(narrowLines.length).toBeGreaterThan(wideLines.length);

    // Verify wrapText utility does not cut words
    const sample = 'POCLI connects human product vision with autonomous AI agents';
    const wrapped = wrapText(sample, 25);
    expect(wrapped.length).toBeGreaterThan(1);
    for (const line of wrapped) {
      expect(line.length).toBeLessThanOrEqual(25);
    }
  });

  it('4. Registers /howto in i18n dictionaries and slash commands list', () => {
    // English
    expect(I18N_DICTIONARY.en.howtoTitle).toBeTruthy();
    expect(I18N_DICTIONARY.en.howtoSubtitle).toBeTruthy();
    expect(I18N_DICTIONARY.en.howtoOpenedMsg).toBeTruthy();
    const enCmd = I18N_DICTIONARY.en.slashCommands.find((c) => c.command === '/howto');
    expect(enCmd).toBeDefined();
    expect(enCmd?.description).toContain('workflow guide');

    // Spanish
    expect(I18N_DICTIONARY.es.howtoTitle).toBeTruthy();
    expect(I18N_DICTIONARY.es.howtoSubtitle).toBeTruthy();
    expect(I18N_DICTIONARY.es.howtoOpenedMsg).toBeTruthy();
    const esCmd = I18N_DICTIONARY.es.slashCommands.find((c) => c.command === '/howto');
    expect(esCmd).toBeDefined();
    expect(esCmd?.description).toContain('guía');
  });
});
