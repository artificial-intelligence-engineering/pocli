import { describe, it, expect } from 'vitest';
import {
  MULTIPANEL_ROLES,
  getNextCarouselRole,
} from '../src/tui/CommandCenterApp.js';
import { I18N_DICTIONARY } from '../src/core/i18n.js';
import { getHowtoSections } from '../src/tui/howtoContent.js';

describe('Feature #44 — Multipanel Left/Right Arrow Carousel Agent Navigation', () => {
  it('1. Defines the standard 4-agent multipanel order', () => {
    expect(MULTIPANEL_ROLES).toEqual(['pm', 'architect', 'developer', 'qa']);
  });

  it('2. Cycles forward (right arrow) in carousel wrap-around mode', () => {
    expect(getNextCarouselRole('pm', 'next')).toBe('architect');
    expect(getNextCarouselRole('architect', 'next')).toBe('developer');
    expect(getNextCarouselRole('developer', 'next')).toBe('qa');
    expect(getNextCarouselRole('qa', 'next')).toBe('pm'); // wrap-around
  });

  it('3. Cycles backward (left arrow) in carousel wrap-around mode', () => {
    expect(getNextCarouselRole('pm', 'prev')).toBe('qa'); // wrap-around
    expect(getNextCarouselRole('qa', 'prev')).toBe('developer');
    expect(getNextCarouselRole('developer', 'prev')).toBe('architect');
    expect(getNextCarouselRole('architect', 'prev')).toBe('pm');
  });

  it('4. Handles unknown roles gracefully without errors', () => {
    // Falls back to index 0 ('pm')
    expect(getNextCarouselRole('product_owner' as any, 'next')).toBe('architect');
    expect(getNextCarouselRole('product_owner' as any, 'prev')).toBe('qa');
  });

  it('5. Updates returnToCleanViewHint in i18n dictionaries with arrow navigation', () => {
    expect(I18N_DICTIONARY.en.returnToCleanViewHint).toContain('←/→');
    expect(I18N_DICTIONARY.es.returnToCleanViewHint).toContain('←/→');
  });

  it('6. Updates howto workflow guide shortcuts to document ← / → in Multipanel', () => {
    const esSections = getHowtoSections('es');
    const esShortcuts = esSections.find((s) => s.badge === '[★]');
    const esArrowBullet = esShortcuts?.bullets?.find((b) => b.command === '← / →');
    expect(esArrowBullet).toBeDefined();
    expect(esArrowBullet?.text).toContain('carrusel');

    const enSections = getHowtoSections('en');
    const enShortcuts = enSections.find((s) => s.badge === '[★]');
    const enArrowBullet = enShortcuts?.bullets?.find((b) => b.command === '← / →');
    expect(enArrowBullet).toBeDefined();
    expect(enArrowBullet?.text).toContain('carousel');
  });
});
