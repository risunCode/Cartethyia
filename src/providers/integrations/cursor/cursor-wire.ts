/**
 * Minimal protobuf wire codec for the Cursor agent protocol.
 *
 * Cursor's `agent.v1` descriptor is large (600+ messages) and only a handful
 * are on the turn path. Rather than vendor a code generator or a proto
 * runtime, this encodes and decodes exactly the messages the adapter speaks.
 * Field numbers come from Cursor's own descriptor and are pinned by a fixture
 * test, so a wrong number fails loudly instead of silently misreading a turn.
 *
 * Only what the turn needs is implemented: varint, length-delimited bytes and
 * strings, and nested messages. Fixed-width types and packed repeats are not
 * used by any message we send or read.
 */

export type WireFields = Map<number, WireValue[]>;

export type WireValue =
  | { readonly kind: "varint"; readonly value: number }
  | { readonly kind: "bytes"; readonly value: Uint8Array };

const WIRE_VARINT = 0;
const WIRE_LENGTH = 2;

export function encodeVarint(value: number): Uint8Array {
  const out: number[] = [];
  let rest = value >>> 0;
  while (rest > 0x7f) {
    out.push((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  out.push(rest);
  return Uint8Array.from(out);
}

function encodeKey(field: number, wire: number): Uint8Array {
  return encodeVarint((field << 3) | wire);
}

export function encodeBytes(field: number, value: Uint8Array): Uint8Array {
  return concat(encodeKey(field, WIRE_LENGTH), encodeVarint(value.length), value);
}

export function encodeString(field: number, value: string): Uint8Array {
  return encodeBytes(field, new TextEncoder().encode(value));
}

export function encodeVarintField(field: number, value: number): Uint8Array {
  return concat(encodeKey(field, WIRE_VARINT), encodeVarint(value));
}

export function encodeMessage(field: number, body: Uint8Array): Uint8Array {
  return encodeBytes(field, body);
}

export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Decode a message body into its fields. Unknown wire types raise. */
export function decodeMessage(bytes: Uint8Array): WireFields {
  const fields: WireFields = new Map();
  let offset = 0;
  while (offset < bytes.length) {
    const key = readVarint(bytes, offset);
    offset = key.offset;
    const field = key.value >>> 3;
    const wire = key.value & 0x7;
    let value: WireValue;
    if (wire === WIRE_VARINT) {
      const read = readVarint(bytes, offset);
      offset = read.offset;
      value = { kind: "varint", value: read.value };
    } else if (wire === WIRE_LENGTH) {
      const length = readVarint(bytes, offset);
      offset = length.offset;
      const end = offset + length.value;
      if (end > bytes.length) throw new Error("truncated length-delimited field");
      value = { kind: "bytes", value: bytes.subarray(offset, end) };
      offset = end;
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
    const list = fields.get(field);
    if (list) list.push(value);
    else fields.set(field, [value]);
  }
  return fields;
}

function readVarint(bytes: Uint8Array, start: number): { readonly value: number; readonly offset: number } {
  let value = 0;
  let shift = 0;
  let offset = start;
  while (offset < bytes.length) {
    const byte = bytes[offset]!;
    offset += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, offset };
    shift += 7;
    if (shift > 28) throw new Error("varint too long");
  }
  throw new Error("truncated varint");
}

export function firstBytes(fields: WireFields, field: number): Uint8Array | undefined {
  const value = fields.get(field)?.[0];
  return value?.kind === "bytes" ? value.value : undefined;
}

export function firstString(fields: WireFields, field: number): string | undefined {
  const bytes = firstBytes(fields, field);
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
}

export function firstVarint(fields: WireFields, field: number): number | undefined {
  const value = fields.get(field)?.[0];
  return value?.kind === "varint" ? value.value : undefined;
}

export function allBytes(fields: WireFields, field: number): readonly Uint8Array[] {
  return (fields.get(field) ?? []).flatMap((value) => (value.kind === "bytes" ? [value.value] : []));
}

/** A protobuf map field is a repeated message of key = 1, value = 2. */
export function decodeBytesMap(fields: WireFields, field: number): ReadonlyMap<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const entry of allBytes(fields, field)) {
    const decoded = decodeMessage(entry);
    const key = firstString(decoded, 1);
    const value = firstBytes(decoded, 2);
    if (key !== undefined && value !== undefined) out.set(key, value);
  }
  return out;
}
