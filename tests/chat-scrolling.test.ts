import { describe, it, expect } from 'vitest';
import {
  wrapTextLines,
  filterToolingStream,
  computeScrollbar,
  calculateScrollJump,
  sliceChatLines,
  buildChatVisualLines,
  ChatVisualItem,
} from '../src/tui/chat-scrolling.js';

describe('Chat Scrolling & Scrollbar Geometry', () => {
  describe('wrapTextLines', () => {
    it('returns a single empty line for empty or falsy strings', () => {
      expect(wrapTextLines('', 40)).toEqual(['']);
    });

    it('keeps short text on one line', () => {
      expect(wrapTextLines('Hello world', 40)).toEqual(['Hello world']);
    });

    it('wraps long lines respecting word boundaries', () => {
      const text = 'The quick brown fox jumps over the lazy dog near the riverbank';
      const lines = wrapTextLines(text, 25);
      expect(lines.length).toBeGreaterThan(1);
      for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(25);
      }
    });

    it('forces hard break on very long continuous words without spaces', () => {
      const longWord = 'a'.repeat(45);
      const lines = wrapTextLines(longWord, 20);
      expect(lines.length).toBe(3);
      expect(lines[0].length).toBe(20);
      expect(lines[1].length).toBe(20);
      expect(lines[2].length).toBe(5);
    });
  });

  describe('computeScrollbar', () => {
    it('disables scrollbar when content fits within viewport', () => {
      const state = computeScrollbar(10, 20, 0);
      expect(state.showScrollbar).toBe(false);
      expect(state.maxScroll).toBe(0);
      expect(state.scrollOffset).toBe(0);
      expect(state.thumbTop).toBe(0);
      expect(state.thumbHeight).toBe(20);
      expect(state.trackRows.length).toBe(20);
    });

    it('calculates thumb at the bottom when scrollOffset is 0', () => {
      // 50 total lines, 20 viewport lines -> maxScroll = 30
      const state = computeScrollbar(50, 20, 0);
      expect(state.showScrollbar).toBe(true);
      expect(state.maxScroll).toBe(30);
      expect(state.scrollOffset).toBe(0);
      expect(state.scrollPos).toBe(30);
      // thumbHeight = round(20/50 * 20) = 8
      expect(state.thumbHeight).toBe(8);
      // thumbTop = 20 - 8 = 12 (at bottom)
      expect(state.thumbTop).toBe(12);
      expect(state.trackRows.slice(0, 12).every((c) => c === '░')).toBe(true);
      expect(state.trackRows.slice(12, 20).every((c) => c === '█')).toBe(true);
    });

    it('calculates thumb at the top when scrollOffset is maxScroll', () => {
      const state = computeScrollbar(50, 20, 30);
      expect(state.showScrollbar).toBe(true);
      expect(state.scrollOffset).toBe(30);
      expect(state.scrollPos).toBe(0);
      expect(state.thumbTop).toBe(0);
      expect(state.trackRows.slice(0, 8).every((c) => c === '█')).toBe(true);
      expect(state.trackRows.slice(8, 20).every((c) => c === '░')).toBe(true);
    });

    it('positions thumb in the middle when scrolled halfway', () => {
      const state = computeScrollbar(50, 20, 15);
      expect(state.showScrollbar).toBe(true);
      expect(state.scrollOffset).toBe(15);
      expect(state.scrollPos).toBe(15);
      expect(state.thumbTop).toBe(6);
      expect(state.trackRows[5]).toBe('░');
      expect(state.trackRows.slice(6, 14).every((c) => c === '█')).toBe(true);
      expect(state.trackRows[14]).toBe('░');
    });

    it('clamps scrollOffset outside bounds', () => {
      const negative = computeScrollbar(50, 20, -10);
      expect(negative.scrollOffset).toBe(0);

      const excessive = computeScrollbar(50, 20, 999);
      expect(excessive.scrollOffset).toBe(30);
    });
  });

  describe('calculateScrollJump', () => {
    it('returns 0 when viewport cannot scroll', () => {
      expect(calculateScrollJump(5, 20, 0)).toBe(0);
    });

    it('jumps to top (maxScroll) when clicking top row (0)', () => {
      // viewport 20 rows, maxScroll 40
      const offset = calculateScrollJump(0, 20, 40);
      expect(offset).toBe(40);
    });

    it('jumps to bottom (0) when clicking bottom row (19)', () => {
      const offset = calculateScrollJump(19, 20, 40);
      expect(offset).toBe(0);
    });

    it('jumps proportionally when clicking middle row', () => {
      const offset = calculateScrollJump(9, 19, 36);
      // fraction = 9 / 18 = 0.5 -> targetScrollPos = 18 -> offset = 36 - 18 = 18
      expect(offset).toBe(18);
    });
  });

  describe('sliceChatLines', () => {
    const sampleItems: ChatVisualItem[] = Array.from({ length: 30 }, (_, idx) => ({
      id: `item-${idx}`,
      kind: 'assistant-text',
      text: `Line content #${idx}`,
    }));

    it('returns all lines with padding when content is shorter than viewport', () => {
      const short = sampleItems.slice(0, 5);
      const res = sliceChatLines(short, 10, 0);
      expect(res.visibleLines.length).toBe(5);
      expect(res.emptyPaddingRows).toBe(5);
      expect(res.startLineIdx).toBe(0);
      expect(res.endLineIdx).toBe(5);
    });

    it('returns bottom-most lines when scrollOffset is 0', () => {
      const res = sliceChatLines(sampleItems, 10, 0);
      expect(res.visibleLines.length).toBe(10);
      expect(res.visibleLines[0].id).toBe('item-20');
      expect(res.visibleLines[9].id).toBe('item-29');
      expect(res.emptyPaddingRows).toBe(0);
    });

    it('returns top-most lines when scrollOffset is maxScroll', () => {
      const res = sliceChatLines(sampleItems, 10, 20);
      expect(res.visibleLines.length).toBe(10);
      expect(res.visibleLines[0].id).toBe('item-0');
      expect(res.visibleLines[9].id).toBe('item-9');
    });

    it('returns intermediate slice when scrollOffset is in between', () => {
      const res = sliceChatLines(sampleItems, 10, 5);
      // maxScroll = 20, offset = 5 -> startLine = 15
      expect(res.visibleLines.length).toBe(10);
      expect(res.visibleLines[0].id).toBe('item-15');
      expect(res.visibleLines[9].id).toBe('item-24');
    });
  });

  describe('buildChatVisualLines', () => {
    it('generates an empty session state line when there are no messages', () => {
      const lines = buildChatVisualLines({
        messages: [],
        chatContentWidth: 60,
        language: 'es',
        activeRoleDisplayName: 'Arquitecto',
      });
      expect(lines.length).toBe(1);
      expect(lines[0].kind).toBe('empty-state');
      expect(lines[0].text).toContain('Arquitecto');
    });

    it('decomposes user message into padded card lines', () => {
      const lines = buildChatVisualLines({
        messages: [
          {
            id: 1,
            fromRole: 'product_owner',
            content: 'Please design the architecture for the new Todo CLI.',
          },
        ],
        chatContentWidth: 60,
        language: 'en',
      });

      expect(lines.length).toBeGreaterThanOrEqual(4);
      expect(lines[0].kind).toBe('user-card-pad');
      expect(lines[1].kind).toBe('user-card-line');
      expect(lines[1].text).toContain('Please design');
      expect(lines[lines.length - 2].kind).toBe('user-card-pad');
      expect(lines[lines.length - 1].kind).toBe('separator');
    });

    it('decomposes long assistant responses into individual visual lines', () => {
      const longResponse = [
        '# ARCH-001: Reference Architecture',
        '## 1. Domain Model',
        'The core domain contains pure validation logic.',
        '## 2. SQLite Persistence Layer',
        'We decouple SQLite migrations and schema queries.',
        '## 3. CLI Presentation Interface',
        'Using commander and ink for terminal presentation.',
        '## 4. Repository Structure',
        'Single repository layout under src/.',
      ].join('\n\n');

      const lines = buildChatVisualLines({
        messages: [
          {
            id: 2,
            fromRole: 'architect',
            content: longResponse,
          },
        ],
        chatContentWidth: 40,
        language: 'en',
        activeModelDisplayName: 'Claude 3.7 Sonnet',
      });

      // Long response decomposed into multiple visual lines plus footer and separator
      expect(lines.length).toBeGreaterThan(15);
      const footer = lines.find((l) => l.kind === 'assistant-footer');
      expect(footer).toBeDefined();
      expect(footer?.text).toBe('Claude 3.7 Sonnet');
    });

    it('handles markdown code blocks with styled border lines', () => {
      const contentWithCode = [
        'Here is the database schema definition:',
        '```sql',
        'CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL);',
        'CREATE INDEX idx_tasks_title ON tasks(title);',
        '```',
        'Let me know if you approve this schema.',
      ].join('\n');

      const lines = buildChatVisualLines({
        messages: [
          {
            id: 3,
            fromRole: 'architect',
            content: contentWithCode,
          },
        ],
        chatContentWidth: 60,
      });

      const topBorder = lines.find((l) => l.kind === 'assistant-code-top');
      const bottomBorder = lines.find((l) => l.kind === 'assistant-code-bottom');
      const codeLines = lines.filter((l) => l.kind === 'assistant-code-line');

      expect(topBorder).toBeDefined();
      expect(topBorder?.text).toBe('sql');
      expect(codeLines.length).toBe(2);
      expect(codeLines[0].text).toContain('CREATE TABLE');
      expect(bottomBorder).toBeDefined();
    });

    it('includes thinking and streaming indicators at the bottom', () => {
      const lines = buildChatVisualLines({
        messages: [
          {
            id: 4,
            fromRole: 'product_owner',
            content: 'Hello',
          },
        ],
        activeStreamingText: 'Analyzing system requirements...',
        chatContentWidth: 50,
        activeRoleDisplayName: 'Software Architect',
      });

      const streamHeader = lines.find((l) => l.kind === 'streaming-header');
      const streamLines = lines.filter((l) => l.kind === 'streaming-line');

      expect(streamHeader).toBeDefined();
      expect(streamHeader?.text).toContain('Software Architect · streaming');
      expect(streamLines.length).toBeGreaterThan(0);
      expect(streamLines[streamLines.length - 1].text).toContain('█');
    });

    it('suppresses raw tool call dumps from assistant messages', () => {
      const lines = buildChatVisualLines({
        messages: [
          {
            id: 5,
            fromRole: 'architect',
            content: 'Architecture design completed.',
            metadataJson: JSON.stringify({
              toolCalls: [
                {
                  name: 'write_architecture_doc',
                  arguments: {
                    code: 'ARCH-001',
                    content: '# Very long architecture content with raw diagrams',
                  },
                },
              ],
            }),
          },
        ],
        chatContentWidth: 60,
      });

      // Does not contain any assistant-tool-box or raw JSON payload
      const toolBoxes = lines.filter((l) => l.kind === 'assistant-tool-box');
      const toolHeaders = lines.filter((l) => l.kind === 'assistant-tool-header');
      expect(toolBoxes).toHaveLength(0);
      expect(toolHeaders).toHaveLength(0);

      // Conversational content is preserved
      expect(lines.some((l) => l.text.includes('Architecture design completed.'))).toBe(true);
    });

    it('displays artifact creation indicator when streaming tool calls instead of raw JSON', () => {
      const linesEs = buildChatVisualLines({
        messages: [],
        activeStreamingText:
          'Iniciando diseño.\n```tool_call\n{"name": "write_specification", "arguments": {"code": "SPEC-001"}}',
        chatContentWidth: 60,
        activeRoleDisplayName: 'Software Architect',
        language: 'es',
      });

      // Conversational stream header and text before tool call are rendered
      expect(linesEs.some((l) => l.text.includes('Iniciando diseño.'))).toBe(true);
      // Raw tool_call JSON is NOT rendered in streaming lines
      expect(linesEs.some((l) => l.text.includes('write_specification'))).toBe(false);

      // Tooling indicator identical to thinking is displayed
      const toolingIndEs = linesEs.find((l) => l.id === 'busy-tooling-indicator');
      expect(toolingIndEs).toBeDefined();
      expect(toolingIndEs?.text).toContain('[Creando artefactos...]');

      // Test English translation
      const linesEn = buildChatVisualLines({
        messages: [],
        activeStreamingText: '```tool_call\n{"name": "write_architecture_doc"}',
        chatContentWidth: 60,
        activeRoleDisplayName: 'Software Architect',
        language: 'en',
      });
      const toolingIndEn = linesEn.find((l) => l.id === 'busy-tooling-indicator');
      expect(toolingIndEn).toBeDefined();
      expect(toolingIndEn?.text).toContain('[Creating artifacts...]');
    });
  });

  describe('filterToolingStream', () => {
    it('returns original stream when no tool call is present', () => {
      const res = filterToolingStream('Everything looks good, proceeding with analysis.');
      expect(res.displayText).toBe('Everything looks good, proceeding with analysis.');
      expect(res.isTooling).toBe(false);
    });

    it('extracts conversational text and flags tooling when ```tool_call starts', () => {
      const raw =
        'He diseñado la estructura.\n```tool_call\n{"name": "write_architecture_doc", "arguments": {}}';
      const res = filterToolingStream(raw);
      expect(res.displayText).toBe('He diseñado la estructura.');
      expect(res.isTooling).toBe(true);
    });

    it('handles direct tool calls without conversational text', () => {
      const raw = '{"name": "write_source_file", "arguments": {"relFilePath": "index.ts"}}';
      const res = filterToolingStream(raw);
      expect(res.displayText).toBe('');
      expect(res.isTooling).toBe(true);
    });

    it('detects partial opening of tool block while streaming', () => {
      const raw = 'Generando especificación técnica...\n```tool';
      const res = filterToolingStream(raw);
      expect(res.displayText).toBe('Generando especificación técnica...');
      expect(res.isTooling).toBe(true);
    });
  });
});
