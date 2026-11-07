/**
 * chat-scrolling.ts
 *
 * Line-based chat viewport calculation, text decomposition, scroll clamping,
 * scrollbar geometry, and keyboard/mouse scrolling navigation for PoCli.
 */

export const wrapTextLines = (text: string, maxCols: number): string[] => {
  if (!text) return [''];
  const safeCols = Math.max(10, maxCols);
  const result: string[] = [];
  const paragraphs = text.split('\n');

  for (const para of paragraphs) {
    if (para.length <= safeCols) {
      result.push(para);
    } else {
      let remaining = para;
      while (remaining.length > safeCols) {
        let breakIdx = remaining.lastIndexOf(' ', safeCols);
        if (breakIdx <= 0) {
          result.push(remaining.slice(0, safeCols));
          remaining = remaining.slice(safeCols);
        } else {
          result.push(remaining.slice(0, breakIdx));
          remaining = remaining.slice(breakIdx + 1);
        }
      }
      result.push(remaining);
    }
  }
  return result;
};

export function filterToolingStream(rawStream: string): {
  displayText: string;
  isTooling: boolean;
} {
  if (!rawStream) return { displayText: '', isTooling: false };

  const toolMarkers = [
    '```tool_call',
    '```tool',
    '```json\n{"name"',
    '```json\r\n{"name"',
    '```json\n{"tool"',
    '```json\r\n{"tool"',
    '{"name": "write_',
    '{"name":"write_',
    '{"name": "record_adr',
    '{"name":"record_adr',
    '{"name": "propose_requirement',
    '{"name":"propose_requirement',
    '{"name": "evaluate_consultation',
    '{"name":"evaluate_consultation',
    '{"name": "consult_architect',
    '{"name":"consult_architect',
    '{"name": "submit_for_qa',
    '{"name":"submit_for_qa',
    '{"tool": "write_',
    '{"tool":"write_',
    '{"tool": "record_adr',
    '{"tool":"record_adr',
    '{"tool": "propose_requirement',
    '{"tool":"propose_requirement',
    '{"name": "write_source_file',
    '{"tool": "write_source_file',
  ];

  let earliestIdx = -1;
  for (const marker of toolMarkers) {
    const idx = rawStream.indexOf(marker);
    if (idx !== -1 && (earliestIdx === -1 || idx < earliestIdx)) {
      earliestIdx = idx;
    }
  }

  if (earliestIdx !== -1) {
    const before = rawStream.slice(0, earliestIdx).trimEnd();
    return {
      displayText: before,
      isTooling: true,
    };
  }

  const partialMarker = '```tool';
  const lastFenceIdx = rawStream.lastIndexOf('```');
  if (lastFenceIdx !== -1 && lastFenceIdx >= rawStream.length - 12) {
    const tail = rawStream.slice(lastFenceIdx);
    if (partialMarker.startsWith(tail)) {
      const before = rawStream.slice(0, lastFenceIdx).trimEnd();
      return {
        displayText: before,
        isTooling: true,
      };
    }
  }

  return { displayText: rawStream, isTooling: false };
}

export type ChatVisualItemKind =
  | 'empty-state'
  | 'user-card-pad'
  | 'user-card-line'
  | 'assistant-citation-header'
  | 'assistant-citation-box'
  | 'assistant-tool-header'
  | 'assistant-tool-box'
  | 'assistant-text'
  | 'assistant-code-top'
  | 'assistant-code-line'
  | 'assistant-code-bottom'
  | 'assistant-footer'
  | 'thinking'
  | 'streaming-header'
  | 'streaming-line'
  | 'separator';

export interface ChatVisualItem {
  id: string;
  kind: ChatVisualItemKind;
  text: string;
  isUser?: boolean;
  isError?: boolean;
  queueBadge?: string;
  sourceMessageId?: string | number;
  codeBorderLang?: string;
}

export interface BuildChatVisualLinesOptions {
  messages: Array<{
    id: string | number;
    fromRole: string;
    toRole?: string;
    content: string;
    metadataJson?: string;
  }>;
  activeStreamingText?: string;
  isActiveRoleBusy?: boolean;
  activeRoleQueuedCount?: number;
  activeRoleDisplayName?: string;
  activeModelDisplayName?: string;
  chatContentWidth: number;
  language?: 'en' | 'es';
  thinkingSpinner?: string;
  queuedMessageIds?: Set<string | number>;
}

export interface ScrollbarState {
  showScrollbar: boolean;
  totalLines: number;
  viewportHeight: number;
  maxScroll: number;
  scrollOffset: number;
  scrollPos: number;
  thumbHeight: number;
  thumbTop: number;
  trackRows: string[];
}

/**
 * Computes scrollbar dimensions, clamped scroll position, thumb size,
 * and track character rows ('█' and '░') for terminal viewports.
 */
export function computeScrollbar(
  totalLines: number,
  viewportHeight: number,
  scrollOffset: number,
): ScrollbarState {
  const safeViewport = Math.max(1, viewportHeight);
  const maxScroll = Math.max(0, totalLines - safeViewport);
  const clampedOffset = Math.max(0, Math.min(scrollOffset, maxScroll));
  const showScrollbar = totalLines > safeViewport;

  // scrollPos: 0 = top of conversation history, maxScroll = newest bottom
  const scrollPos = maxScroll - clampedOffset;

  const trackHeight = safeViewport;
  const thumbHeight = showScrollbar
    ? Math.max(
        1,
        Math.min(
          trackHeight,
          Math.round((safeViewport / Math.max(1, totalLines)) * trackHeight),
        ),
      )
    : trackHeight;

  const travel = trackHeight - thumbHeight;
  const thumbTop =
    showScrollbar && maxScroll > 0 && travel > 0
      ? Math.max(0, Math.min(travel, Math.round((scrollPos / maxScroll) * travel)))
      : 0;

  const trackRows: string[] = [];
  for (let r = 0; r < trackHeight; r++) {
    if (showScrollbar && r >= thumbTop && r < thumbTop + thumbHeight) {
      trackRows.push('█');
    } else {
      trackRows.push('░');
    }
  }

  return {
    showScrollbar,
    totalLines,
    viewportHeight: safeViewport,
    maxScroll,
    scrollOffset: clampedOffset,
    scrollPos,
    thumbHeight,
    thumbTop,
    trackRows,
  };
}

/**
 * Calculates new scrollOffset when clicking on a row of the scrollbar track.
 */
export function calculateScrollJump(
  clickRow: number,
  viewportHeight: number,
  maxScroll: number,
): number {
  if (viewportHeight <= 1 || maxScroll <= 0) return 0;
  const clampedRow = Math.max(0, Math.min(viewportHeight - 1, clickRow));
  const fraction = clampedRow / (viewportHeight - 1);
  const targetScrollPos = Math.round(fraction * maxScroll);
  return Math.max(0, Math.min(maxScroll, maxScroll - targetScrollPos));
}

/**
 * Slices the visual lines array according to the viewport height and scroll offset.
 */
export function sliceChatLines(
  lines: ChatVisualItem[],
  viewportHeight: number,
  scrollOffset: number,
): {
  visibleLines: ChatVisualItem[];
  startLineIdx: number;
  endLineIdx: number;
  emptyPaddingRows: number;
} {
  const safeViewport = Math.max(1, viewportHeight);
  const total = lines.length;
  if (total <= safeViewport) {
    return {
      visibleLines: [...lines],
      startLineIdx: 0,
      endLineIdx: total,
      emptyPaddingRows: safeViewport - total,
    };
  }

  const maxScroll = total - safeViewport;
  const clampedOffset = Math.max(0, Math.min(scrollOffset, maxScroll));
  const startLineIdx = maxScroll - clampedOffset;
  const endLineIdx = startLineIdx + safeViewport;
  const visibleLines = lines.slice(startLineIdx, endLineIdx);

  return {
    visibleLines,
    startLineIdx,
    endLineIdx,
    emptyPaddingRows: Math.max(0, safeViewport - visibleLines.length),
  };
}

/**
 * Decomposes conversation messages, tool calls, citations, and streaming text
 * into individual visual line items for fixed-height line-by-line scrolling.
 */
export function buildChatVisualLines(
  options: BuildChatVisualLinesOptions,
): ChatVisualItem[] {
  const {
    messages,
    activeStreamingText,
    isActiveRoleBusy = false,
    activeRoleQueuedCount = 0,
    activeRoleDisplayName = 'Specialist',
    activeModelDisplayName = 'LLM',
    chatContentWidth,
    language = 'en',
    thinkingSpinner = '·',
    queuedMessageIds = new Set<string | number>(),
  } = options;

  const result: ChatVisualItem[] = [];
  const safeWidth = Math.max(10, chatContentWidth);

  // 1. Empty conversation state
  if (messages.length === 0 && !activeStreamingText) {
    result.push({
      id: 'empty-session-line',
      kind: 'empty-state',
      text:
        language === 'es'
          ? `→ Sesión iniciada con ${activeRoleDisplayName}. Escribe una consulta para comenzar.`
          : `→ Active session with ${activeRoleDisplayName}. Enter a prompt to start.`,
    });
    return result;
  }

  // 2. Format existing conversation messages
  messages.forEach((m, mIdx) => {
    const isUser = m.fromRole === 'product_owner';

    if (isUser) {
      // User message card
      const textWidth = Math.max(10, safeWidth - 2);
      const queueBadge = queuedMessageIds.has(m.id)
        ? language === 'es'
          ? ' [en cola]'
          : ' [queued]'
        : '';
      const rawMsgLines = wrapTextLines(
        m.content,
        Math.max(10, textWidth - queueBadge.length - 1),
      );

      // Top padding line
      result.push({
        id: `msg-${m.id}-pad-top`,
        kind: 'user-card-pad',
        text: '',
        isUser: true,
        sourceMessageId: m.id,
      });

      // User card text lines
      rawMsgLines.forEach((line, lIdx) => {
        result.push({
          id: `msg-${m.id}-line-${lIdx}`,
          kind: 'user-card-line',
          text: line,
          isUser: true,
          queueBadge: lIdx === 0 ? queueBadge : '',
          sourceMessageId: m.id,
        });
      });

      // Bottom padding line
      result.push({
        id: `msg-${m.id}-pad-bot`,
        kind: 'user-card-pad',
        text: '',
        isUser: true,
        sourceMessageId: m.id,
      });

      // Separator after card
      result.push({
        id: `msg-${m.id}-sep`,
        kind: 'separator',
        text: '',
        sourceMessageId: m.id,
      });
    } else {
      // Assistant message: parse metadata (citations, tool calls, error flag)
      let citations: string[] = [];
      let toolCalls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
      let isErrMsg = m.content.startsWith('✖');

      try {
        const meta = JSON.parse(m.metadataJson || '{}') as {
          citations?: string[];
          toolCalls?: Array<{ name: string; arguments?: Record<string, unknown> }>;
          isError?: boolean;
        };
        if (Array.isArray(meta.citations)) citations = meta.citations;
        if (Array.isArray(meta.toolCalls)) toolCalls = meta.toolCalls;
        if (meta.isError) isErrMsg = true;
      } catch {
        // ignore JSON parse error
      }

      if (m.fromRole === 'architect') {
        result.push({
          id: `msg-${m.id}-handoff-badge`,
          kind: 'assistant-citation-header',
          text:
            language === 'es'
              ? '🤝 [ARQ → DEV] Traspaso Normativo de Arquitectura y Especificaciones'
              : '🤝 [ARQ → DEV] Normative Architecture & Specification Handoff',
          sourceMessageId: m.id,
        });
      } else if (m.fromRole === 'developer' && m.toRole === 'architect') {
        result.push({
          id: `msg-${m.id}-dev-report-badge`,
          kind: 'assistant-citation-header',
          text:
            language === 'es'
              ? '📋 [DEV → ARQ] Informe de Implementación, Pruebas Unitarias y Cobertura'
              : '📋 [DEV → ARQ] Implementation, Unit Tests & Coverage Report',
          sourceMessageId: m.id,
        });
      }

      // Citations header and block
      if (citations.length > 0) {
        result.push({
          id: `msg-${m.id}-cit-header`,
          kind: 'assistant-citation-header',
          text: `→ Explored: ${citations.length} reads`,
          sourceMessageId: m.id,
        });
        result.push({
          id: `msg-${m.id}-cit-box`,
          kind: 'assistant-citation-box',
          text: `$ Notebook Citations: ${citations.slice(0, 3).join(' ')}`,
          sourceMessageId: m.id,
        });
      }

      // Decompose content text lines and code blocks
      const contentLines = m.content.split('\n');
      let inCodeBlock = false;
      let codeLang = '';

      for (let i = 0; i < contentLines.length; i++) {
        const line = contentLines[i];
        const trimmed = line.trim();

        if (trimmed.startsWith('```')) {
          if (!inCodeBlock) {
            inCodeBlock = true;
            codeLang = trimmed.slice(3).trim();
            result.push({
              id: `msg-${m.id}-code-top-${i}`,
              kind: 'assistant-code-top',
              text: codeLang || 'code',
              codeBorderLang: codeLang,
              sourceMessageId: m.id,
            });
          } else {
            inCodeBlock = false;
            result.push({
              id: `msg-${m.id}-code-bot-${i}`,
              kind: 'assistant-code-bottom',
              text: '',
              sourceMessageId: m.id,
            });
          }
          continue;
        }

        if (inCodeBlock) {
          result.push({
            id: `msg-${m.id}-code-line-${i}`,
            kind: 'assistant-code-line',
            text: line,
            sourceMessageId: m.id,
          });
        } else {
          if (line === '') {
            result.push({
              id: `msg-${m.id}-text-empty-${i}`,
              kind: 'assistant-text',
              text: '',
              isError: isErrMsg,
              sourceMessageId: m.id,
            });
          } else {
            const wrapped = wrapTextLines(line, Math.max(10, safeWidth - 4));
            wrapped.forEach((wLine, wIdx) => {
              result.push({
                id: `msg-${m.id}-text-${i}-${wIdx}`,
                kind: 'assistant-text',
                text: wLine,
                isError: isErrMsg,
                sourceMessageId: m.id,
              });
            });
          }
        }
      }

      // Close unclosed code block if necessary
      if (inCodeBlock) {
        result.push({
          id: `msg-${m.id}-code-bot-auto`,
          kind: 'assistant-code-bottom',
          text: '',
          sourceMessageId: m.id,
        });
      }

      // Assistant footer (Build / Error badge)
      result.push({
        id: `msg-${m.id}-footer`,
        kind: 'assistant-footer',
        text: activeModelDisplayName,
        isError: isErrMsg,
        sourceMessageId: m.id,
      });

      // Separator after message
      result.push({
        id: `msg-${m.id}-sep`,
        kind: 'separator',
        text: '',
        sourceMessageId: m.id,
      });
    }
  });

  // 3. Thinking / Waiting indicator
  if (isActiveRoleBusy && !activeStreamingText) {
    const queueNote =
      activeRoleQueuedCount > 0
        ? language === 'es'
          ? `[Pensando respuesta... · ${activeRoleQueuedCount} en cola]`
          : `[Thinking... · ${activeRoleQueuedCount} queued]`
        : language === 'es'
          ? '[Pensando respuesta...]'
          : '[Thinking...]';

    result.push({
      id: 'busy-thinking-indicator',
      kind: 'thinking',
      text: `${activeRoleDisplayName} ${thinkingSpinner} ${queueNote}`,
    });
  }

  // 4. Active streaming text & Tooling indicator
  if (activeStreamingText) {
    const { displayText, isTooling } = filterToolingStream(activeStreamingText);

    if (displayText) {
      result.push({
        id: 'streaming-header',
        kind: 'streaming-header',
        text: `${activeRoleDisplayName} · streaming`,
      });

      const streamLines = wrapTextLines(
        displayText,
        Math.max(10, safeWidth - 4),
      );
      streamLines.forEach((sLine, sIdx) => {
        const isLast = sIdx === streamLines.length - 1 && !isTooling;
        result.push({
          id: `streaming-line-${sIdx}`,
          kind: 'streaming-line',
          text: isLast ? `${sLine}█` : sLine,
        });
      });
    }

    if (isTooling) {
      const toolingNote =
        language === 'es'
          ? '[Creando artefactos...]'
          : '[Creating artifacts...]';

      result.push({
        id: 'busy-tooling-indicator',
        kind: 'thinking',
        text: `${activeRoleDisplayName} ${thinkingSpinner} ${toolingNote}`,
      });
    }
  }

  return result;
}
