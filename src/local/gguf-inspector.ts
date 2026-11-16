import fs from 'node:fs';
import { GgufMetadata } from './contracts.js';

const GGUF_MAGIC = 0x46554747; // "GGUF" little-endian

const GGUF_TYPE = {
  UINT8: 0,
  INT8: 1,
  UINT16: 2,
  INT16: 3,
  UINT32: 4,
  INT32: 5,
  FLOAT32: 6,
  BOOL: 7,
  STRING: 8,
  ARRAY: 9,
  UINT64: 10,
  INT64: 11,
  FLOAT64: 12,
} as const;

const FILE_TYPE_LABELS: Record<number, string> = {
  0: 'F32',
  1: 'F16',
  2: 'Q4_0',
  3: 'Q4_1',
  7: 'Q8_0',
  8: 'Q5_0',
  9: 'Q5_1',
  10: 'Q2_K',
  11: 'Q3_K_S',
  12: 'Q3_K_M',
  13: 'Q3_K_L',
  14: 'Q4_K_S',
  15: 'Q4_K_M',
  16: 'Q5_K_S',
  17: 'Q5_K_M',
  18: 'Q6_K',
  19: 'IQ2_XXS',
  20: 'IQ2_XS',
  21: 'IQ3_XXS',
  22: 'IQ1_S',
  23: 'IQ4_NL',
  24: 'IQ3_S',
  25: 'IQ2_S',
  26: 'IQ4_XS',
  27: 'IQ1_M',
  28: 'BF16',
  29: 'TQ1_0',
  30: 'TQ2_0',
};

export function inferQuantizationFromFilename(fileName: string): string | undefined {
  const match = fileName.match(
    /(?:^|[-_.])(IQ[1-4]_[A-Z]+|TQ[12]_0|Q[2-8]_K(?:_[SML])?|Q[458]_[01]|F16|BF16|F32)(?=\.gguf$|[-_.])/i,
  );
  return match ? match[1].toUpperCase() : undefined;
}

class BinaryCursor {
  public offset = 0;
  constructor(private readonly buf: Buffer) {}

  private ensure(bytes: number): void {
    if (this.offset + bytes > this.buf.length) {
      throw new Error('GGUF_HEADER_TRUNCATED');
    }
  }

  readUInt8(): number {
    this.ensure(1);
    const v = this.buf.readUInt8(this.offset);
    this.offset += 1;
    return v;
  }

  readInt8(): number {
    this.ensure(1);
    const v = this.buf.readInt8(this.offset);
    this.offset += 1;
    return v;
  }

  readUInt16(): number {
    this.ensure(2);
    const v = this.buf.readUInt16LE(this.offset);
    this.offset += 2;
    return v;
  }

  readInt16(): number {
    this.ensure(2);
    const v = this.buf.readInt16LE(this.offset);
    this.offset += 2;
    return v;
  }

  readUInt32(): number {
    this.ensure(4);
    const v = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  readInt32(): number {
    this.ensure(4);
    const v = this.buf.readInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  readFloat32(): number {
    this.ensure(4);
    const v = this.buf.readFloatLE(this.offset);
    this.offset += 4;
    return v;
  }

  readUInt64(): number {
    this.ensure(8);
    const v = Number(this.buf.readBigUInt64LE(this.offset));
    this.offset += 8;
    return v;
  }

  readInt64(): number {
    this.ensure(8);
    const v = Number(this.buf.readBigInt64LE(this.offset));
    this.offset += 8;
    return v;
  }

  readFloat64(): number {
    this.ensure(8);
    const v = this.buf.readDoubleLE(this.offset);
    this.offset += 8;
    return v;
  }

  readString(): string {
    const len = this.readUInt64();
    if (len > 16 * 1024 * 1024) {
      throw new Error(`GGUF string too large: ${len}`);
    }
    this.ensure(len);
    const str = this.buf.toString('utf8', this.offset, this.offset + len);
    this.offset += len;
    return str;
  }

  skip(bytes: number): void {
    this.ensure(bytes);
    this.offset += bytes;
  }

  readValue(type: number, captureArray = false): unknown {
    switch (type) {
      case GGUF_TYPE.UINT8:
        return this.readUInt8();
      case GGUF_TYPE.INT8:
        return this.readInt8();
      case GGUF_TYPE.UINT16:
        return this.readUInt16();
      case GGUF_TYPE.INT16:
        return this.readInt16();
      case GGUF_TYPE.UINT32:
        return this.readUInt32();
      case GGUF_TYPE.INT32:
        return this.readInt32();
      case GGUF_TYPE.FLOAT32:
        return this.readFloat32();
      case GGUF_TYPE.BOOL:
        return this.readUInt8() !== 0;
      case GGUF_TYPE.STRING:
        return this.readString();
      case GGUF_TYPE.UINT64:
        return this.readUInt64();
      case GGUF_TYPE.INT64:
        return this.readInt64();
      case GGUF_TYPE.FLOAT64:
        return this.readFloat64();
      case GGUF_TYPE.ARRAY: {
        const elemType = this.readUInt32();
        const count = this.readUInt64();
        const fixedSizes: Record<number, number> = {
          [GGUF_TYPE.UINT8]: 1,
          [GGUF_TYPE.INT8]: 1,
          [GGUF_TYPE.BOOL]: 1,
          [GGUF_TYPE.UINT16]: 2,
          [GGUF_TYPE.INT16]: 2,
          [GGUF_TYPE.UINT32]: 4,
          [GGUF_TYPE.INT32]: 4,
          [GGUF_TYPE.FLOAT32]: 4,
          [GGUF_TYPE.UINT64]: 8,
          [GGUF_TYPE.INT64]: 8,
          [GGUF_TYPE.FLOAT64]: 8,
        };
        if (!captureArray && elemType in fixedSizes) {
          this.skip(count * fixedSizes[elemType]);
          return `[array(${count})]`;
        }
        const limit = captureArray ? count : Math.min(count, 200000);
        for (let i = 0; i < limit; i += 1) {
          this.readValue(elemType, false);
        }
        return `[array(${count})]`;
      }
      default:
        throw new Error(`Unsupported GGUF value type: ${type}`);
    }
  }
}

export function parseGgufHeader(
  buffer: Buffer,
  fileNameHint?: string,
): GgufMetadata {
  const cursor = new BinaryCursor(buffer);
  const magic = cursor.readUInt32();
  if (magic !== GGUF_MAGIC) {
    throw new Error('Not a valid GGUF file (missing GGUF magic header).');
  }
  const version = cursor.readUInt32();
  const tensorCount = version >= 2 ? cursor.readUInt64() : cursor.readUInt32();
  const kvCount = version >= 2 ? cursor.readUInt64() : cursor.readUInt32();

  const kv = new Map<string, unknown>();
  const maxKvToRead = Math.min(kvCount, 512);

  for (let i = 0; i < maxKvToRead; i += 1) {
    const key = cursor.readString();
    const valueType = cursor.readUInt32();
    // Skip giant tokenizer arrays cleanly by passing captureArray=false
    const val = cursor.readValue(valueType, false);
    if (!key.startsWith('tokenizer.ggml.tokens') && !key.startsWith('tokenizer.ggml.merges')) {
      kv.set(key, val);
    }
  }

  const arch =
    typeof kv.get('general.architecture') === 'string'
      ? (kv.get('general.architecture') as string)
      : undefined;
  const name =
    typeof kv.get('general.name') === 'string'
      ? (kv.get('general.name') as string)
      : undefined;
  const fileType =
    typeof kv.get('general.file_type') === 'number'
      ? (kv.get('general.file_type') as number)
      : undefined;

  const numField = (suffix: string): number | undefined => {
    if (!arch) return undefined;
    const v = kv.get(`${arch}.${suffix}`);
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
  };

  const quantizationLabel =
    (fileType !== undefined ? FILE_TYPE_LABELS[fileType] : undefined) ??
    (fileNameHint ? inferQuantizationFromFilename(fileNameHint) : undefined);

  return {
    version,
    tensorCount,
    kvCount,
    architecture: arch,
    name,
    contextLength: numField('context_length'),
    blockCount: numField('block_count'),
    embeddingLength: numField('embedding_length'),
    headCount: numField('attention.head_count'),
    headCountKv: numField('attention.head_count_kv'),
    fileType,
    quantizationLabel,
  };
}

/**
 * Inspects a GGUF file on disk by reading only the header (starting at 1 MiB, up to 8 MiB).
 */
export function inspectGgufFile(filePath: string): GgufMetadata {
  const stat = fs.statSync(filePath);
  const sizesToTry = [1024 * 1024, 4 * 1024 * 1024, 16 * 1024 * 1024];

  for (const chunkSize of sizesToTry) {
    const bytesToRead = Math.min(stat.size, chunkSize);
    const buf = Buffer.allocUnsafe(bytesToRead);
    const fd = fs.openSync(filePath, 'r');
    try {
      fs.readSync(fd, buf, 0, bytesToRead, 0);
    } finally {
      fs.closeSync(fd);
    }

    try {
      return parseGgufHeader(buf, filePath);
    } catch (err) {
      if ((err as Error).message === 'GGUF_HEADER_TRUNCATED' && bytesToRead < stat.size) {
        continue;
      }
      throw err;
    }
  }

  throw new Error(`Unable to parse GGUF header within 16 MiB for ${filePath}`);
}
