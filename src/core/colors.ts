/**
 * Lightweight, zero-dependency ANSI color utility for terminal CLI output.
 * Gracefully respects the NO_COLOR standard (https://no-color.org).
 */

export function isColorSupported(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') {
    return false;
  }
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0') {
    return true;
  }
  return Boolean(process.stdout && process.stdout.isTTY);
}

const wrap = (code: string, reset = '\x1b[0m') => (text?: string | number | null): string => {
  const str = text === undefined || text === null ? '' : String(text);
  if (!isColorSupported() || !str) return str;
  return `${code}${str}${reset}`;
};

export const c = {
  bold: wrap('\x1b[1m', '\x1b[22m'),
  dim: wrap('\x1b[2m', '\x1b[22m'),
  red: wrap('\x1b[31m', '\x1b[39m'),
  redBold: wrap('\x1b[1;31m', '\x1b[0m'),
  green: wrap('\x1b[32m', '\x1b[39m'),
  greenBold: wrap('\x1b[1;32m', '\x1b[0m'),
  yellow: wrap('\x1b[33m', '\x1b[39m'),
  yellowBold: wrap('\x1b[1;33m', '\x1b[0m'),
  blue: wrap('\x1b[34m', '\x1b[39m'),
  magenta: wrap('\x1b[35m', '\x1b[39m'),
  magentaBold: wrap('\x1b[1;35m', '\x1b[0m'),
  cyan: wrap('\x1b[36m', '\x1b[39m'),
  cyanBold: wrap('\x1b[1;36m', '\x1b[0m'),
  gray: wrap('\x1b[90m', '\x1b[39m'),
};

/**
 * Format a raw log line (e.g. "[2026-11-04T18:47:11.123Z] [INFO ] [ORCHESTRATOR] message...")
 * with semantic ANSI colors for terminal display.
 */
export function formatLogLineForTerminal(line: string): string {
  if (!isColorSupported()) return line;

  const match = line.match(/^\[(.*?)\]\s+\[(.*?)\]\s+\[(.*?)\]\s*(.*)$/);
  if (!match) return line;

  const [, timestamp, level, category, message] = match;
  const timeFormatted = c.gray(`[${timestamp}]`);

  const trimmedLevel = level.trim().toUpperCase();
  let levelFormatted = `[${level}]`;
  if (trimmedLevel === 'ERROR') {
    levelFormatted = c.redBold(`[${level}]`);
  } else if (trimmedLevel === 'WARN') {
    levelFormatted = c.yellowBold(`[${level}]`);
  } else if (trimmedLevel === 'INFO') {
    levelFormatted = c.green(`[${level}]`);
  } else if (trimmedLevel === 'DEBUG') {
    levelFormatted = c.gray(`[${level}]`);
  }

  const catFormatted = c.magenta(`[${category}]`);

  return `${timeFormatted} ${levelFormatted} ${catFormatted} ${message}`;
}
