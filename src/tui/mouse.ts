/**
 * Terminal Mouse Tracking & SGR (1006) Escape Sequence Parser for Ink TUI.
 *
 * Ink 5 does not provide built-in DOM-like mouse events on `<Box>` components,
 * and by default SGR mouse escape sequences (`\x1b[<btn;col;rowM`) would pass
 * through Ink's `useInput` with the leading `\x1b` stripped (`[<btn;col;rowM`).
 *
 * This module enables xterm SGR Mouse Tracking on stdout and parses mouse
 * clicks and scroll-wheel actions into structured coordinates and events.
 */

export const ENABLE_MOUSE_TRACKING_SEQ = '\x1b[?1000h\x1b[?1006h';
export const DISABLE_MOUSE_TRACKING_SEQ = '\x1b[?1000l\x1b[?1006l';

export type MouseButton =
  | 'left'
  | 'middle'
  | 'right'
  | 'wheel-up'
  | 'wheel-down'
  | 'none';

export type MouseAction = 'press' | 'release' | 'move' | 'wheel';

export interface ParsedMouseEvent {
  button: MouseButton;
  action: MouseAction;
  /** 1-based terminal column coordinate */
  x: number;
  /** 1-based terminal row coordinate */
  y: number;
  shift: boolean;
  meta: boolean;
  ctrl: boolean;
}

const SGR_MOUSE_GLOBAL_RE = /(?:\x1b)?\[<(\d+);(\d+);(\d+)([Mm])/g;
const SGR_MOUSE_DETECT_RE = /(?:\x1b)?\[<\d+;\d+;\d+[Mm]/;
const X10_MOUSE_DETECT_RE = /(?:\x1b)?\[M[\s\S]{3}/;

/**
 * Returns true if the input chunk from Ink's `useInput` or raw `stdin`
 * contains an SGR (`\x1b[<b;x;yM`) or X10 (`\x1b[M...`) mouse sequence.
 */
export function isMouseSequence(input: string): boolean {
  if (!input) return false;
  return SGR_MOUSE_DETECT_RE.test(input) || X10_MOUSE_DETECT_RE.test(input);
}

/**
 * Parses one or more SGR mouse events from a raw stdin chunk or Ink `useInput` string.
 */
export function parseMouseEvents(input: string): ParsedMouseEvent[] {
  if (!input) return [];
  const events: ParsedMouseEvent[] = [];

  for (const match of input.matchAll(SGR_MOUSE_GLOBAL_RE)) {
    const code = Number(match[1]);
    const x = Number(match[2]);
    const y = Number(match[3]);
    const suffix = match[4];

    const shift = Boolean(code & 4);
    const meta = Boolean(code & 8);
    const ctrl = Boolean(code & 16);
    const isMotion = Boolean(code & 32);
    const isWheel = Boolean(code & 64);
    const baseBtn = code & 3;

    if (isWheel) {
      events.push({
        button: baseBtn === 0 ? 'wheel-up' : 'wheel-down',
        action: 'wheel',
        x,
        y,
        shift,
        meta,
        ctrl,
      });
      continue;
    }

    const button: MouseButton =
      baseBtn === 0
        ? 'left'
        : baseBtn === 1
          ? 'middle'
          : baseBtn === 2
            ? 'right'
            : 'none';

    const action: MouseAction = isMotion
      ? 'move'
      : suffix === 'm' || baseBtn === 3
        ? 'release'
        : 'press';

    events.push({
      button,
      action,
      x,
      y,
      shift,
      meta,
      ctrl,
    });
  }

  return events;
}

