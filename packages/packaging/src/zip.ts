/**
 * Minimal, deterministic ZIP writer/reader (STORE method only).
 *
 * Determinism is the whole point (Phase 4.1.1): the same input files always
 * produce identical bytes, so signatures over the archive remain stable.
 * We normalise everything that would otherwise vary:
 *   - file order is sorted by entry name
 *   - timestamps are fixed (DOS epoch, 1980-01-01 00:00:00)
 *   - no extra fields, no comments, no compression
 */

const LOCAL_FILE = 0x04034b50;
const CENTRAL_DIR = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
const VERSION_NEEDED = 20;
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;

let crcTable: Uint32Array | undefined;

/** Standard CRC-32 (ISO 3309 / zlib). */
export function crc32(data: Uint8Array): number {
  let table: Uint32Array;
  if (crcTable) {
    table = crcTable;
  } else {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    crcTable = table;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  /** Forward-slash relative path inside the archive. */
  name: string;
  data: Uint8Array;
}

/**
 * Build a deterministic ZIP archive. Entries are sorted by name; timestamps
 * are pinned to the DOS epoch; all entries are stored uncompressed.
 */
export function createZip(entries: ZipEntry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of sorted) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_FILE, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(METHOD_STORE, 8);
    local.writeUInt16LE(0, 10); // mod time (pinned)
    local.writeUInt16LE(0, 12); // mod date (pinned)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    localParts.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_DIR, 0);
    central.writeUInt16LE(VERSION_NEEDED, 4); // version made by
    central.writeUInt16LE(VERSION_NEEDED, 6); // version needed
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(METHOD_STORE, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);

    offset += local.length + nameBytes.length + data.length;
  }

  const centralStart = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(END_OF_CENTRAL, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(sorted.length, 8);
  eocd.writeUInt16LE(sorted.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

/** Read a STORE-method ZIP archive into a name → bytes map. */
export function readZip(buffer: Uint8Array): Map<string, Uint8Array> {
  const b = Buffer.from(buffer);
  const searchStart = Math.max(0, b.length - 65557);
  let eocdIndex = -1;
  for (let i = b.length - 22; i >= searchStart; i--) {
    if (b.readUInt32LE(i) === END_OF_CENTRAL) {
      eocdIndex = i;
      break;
    }
  }
  if (eocdIndex < 0) throw new Error('Invalid archive: end-of-central-directory record not found');

  const totalEntries = b.readUInt16LE(eocdIndex + 10);
  const centralSize = b.readUInt32LE(eocdIndex + 12);
  const centralOffset = b.readUInt32LE(eocdIndex + 16);
  if (centralOffset + centralSize > eocdIndex) throw new Error('Invalid archive: central directory overlaps EOCD');

  const entries = new Map<string, Uint8Array>();
  let p = centralOffset;
  for (let n = 0; n < totalEntries; n++) {
    if (p + 46 > b.length || b.readUInt32LE(p) !== CENTRAL_DIR) {
      throw new Error('Invalid archive: malformed central directory entry');
    }
    const method = b.readUInt16LE(p + 10);
    const crc = b.readUInt32LE(p + 16);
    const compSize = b.readUInt32LE(p + 20);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    const localOffset = b.readUInt32LE(p + 42);
    const name = b.subarray(p + 46, p + 46 + nameLen).toString('utf8');

    if (method !== METHOD_STORE) {
      throw new Error(`Unsupported compression method ${method} for entry '${name}' (only STORE is supported)`);
    }

    if (localOffset + 30 > b.length || b.readUInt32LE(localOffset) !== LOCAL_FILE) {
      throw new Error(`Invalid archive: malformed local header for '${name}'`);
    }
    const lNameLen = b.readUInt16LE(localOffset + 26);
    const lExtraLen = b.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const data = b.subarray(dataStart, dataStart + compSize);
    if (crc32(data) !== crc) throw new Error(`CRC mismatch for entry '${name}'`);

    entries.set(name, new Uint8Array(data));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
