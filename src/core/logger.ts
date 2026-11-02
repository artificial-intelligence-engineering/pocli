import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  category: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export class Logger {
  private static customLogDir: string | null = null;
  private static ringBuffer: LogEntry[] = [];
  private static maxRingBufferSize = 200;
  private static maxFileSizeBytes = 5 * 1024 * 1024; // 5 MB

  public static setLogDir(dir: string | null): void {
    this.customLogDir = dir;
  }

  public static getLogDir(): string {
    if (this.customLogDir) {
      return this.customLogDir;
    }
    const baseDir =
      process.env.POCLI_HOME || path.join(os.homedir(), '.pocli');
    return path.join(baseDir, 'logs');
  }

  public static getLogFilePath(): string {
    return path.join(this.getLogDir(), 'pocli.log');
  }

  public static debug(
    category: string,
    message: string,
    metadata?: Record<string, unknown>,
  ): void {
    this.log('DEBUG', category, message, metadata);
  }

  public static info(
    category: string,
    message: string,
    metadata?: Record<string, unknown>,
  ): void {
    this.log('INFO', category, message, metadata);
  }

  public static warn(
    category: string,
    message: string,
    metadata?: Record<string, unknown>,
  ): void {
    this.log('WARN', category, message, metadata);
  }

  public static error(
    category: string,
    message: string,
    errOrMetadata?: Error | Record<string, unknown>,
  ): void {
    let meta: Record<string, unknown> | undefined;
    if (errOrMetadata instanceof Error) {
      meta = {
        name: errOrMetadata.name,
        error: errOrMetadata.message,
        stack: errOrMetadata.stack,
      };
    } else if (errOrMetadata) {
      meta = errOrMetadata;
    }
    this.log('ERROR', category, message, meta);
  }

  private static log(
    level: LogLevel,
    category: string,
    message: string,
    metadata?: Record<string, unknown>,
  ): void {
    const timestamp = new Date().toISOString();
    const entry: LogEntry = {
      timestamp,
      level,
      category: category.toUpperCase(),
      message,
      metadata,
    };

    // Store in in-memory ring buffer
    this.ringBuffer.push(entry);
    if (this.ringBuffer.length > this.maxRingBufferSize) {
      this.ringBuffer.shift();
    }

    // Write formatted line to disk
    this.writeToFile(entry);
  }

  public static formatEntry(entry: LogEntry): string {
    const metaStr =
      entry.metadata && Object.keys(entry.metadata).length > 0
        ? ` ${JSON.stringify(entry.metadata)}`
        : '';
    return `[${entry.timestamp}] [${entry.level.padEnd(5, ' ')}] [${entry.category}] ${entry.message}${metaStr}`;
  }

  private static writeToFile(entry: LogEntry): void {
    try {
      const logDir = this.getLogDir();
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      const logPath = this.getLogFilePath();

      // Check rotation if file > 5MB
      if (fs.existsSync(logPath)) {
        try {
          const stats = fs.statSync(logPath);
          if (stats.size > this.maxFileSizeBytes) {
            const rotatedPath = `${logPath}.1`;
            if (fs.existsSync(rotatedPath)) {
              fs.unlinkSync(rotatedPath);
            }
            fs.renameSync(logPath, rotatedPath);
          }
        } catch {
          // Ignore stat/rotation error and continue appending
        }
      }

      const line = this.formatEntry(entry);
      fs.appendFileSync(logPath, `${line}\n`, 'utf8');
    } catch {
      // Intentionally silent: logger must never crash the main application
    }
  }

  public static getRecentLines(count = 100): string[] {
    const logPath = this.getLogFilePath();
    if (!fs.existsSync(logPath)) {
      return this.ringBuffer.slice(-count).map((e) => this.formatEntry(e));
    }
    try {
      const content = fs.readFileSync(logPath, 'utf8');
      const lines = content
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      return lines.slice(-count);
    } catch {
      return this.ringBuffer.slice(-count).map((e) => this.formatEntry(e));
    }
  }

  public static getRecentEntries(count = 100): LogEntry[] {
    return this.ringBuffer.slice(-count);
  }

  public static clear(): void {
    this.ringBuffer = [];
    try {
      const logPath = this.getLogFilePath();
      if (fs.existsSync(logPath)) {
        fs.writeFileSync(logPath, '', 'utf8');
      }
    } catch {
      // Ignore
    }
  }
}

