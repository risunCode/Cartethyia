/**
 * gRPC-web frame decoder for xAI GetGrokCreditsConfig.
 * Decodes the binary protobuf wire format without external dependencies.
 */

const FIELD_CREDITS_INFO = 1;
const CREDITS_FIELD_USAGE_RATIO = 1;
const CREDITS_FIELD_RESET_TIMESTAMP = 5;
const TIMESTAMP_FIELD_SECONDS = 1;
const TIMESTAMP_FIELD_NANOS = 2;

const WIRE_TYPE_VARINT = 0;
const WIRE_TYPE_FIXED64 = 1;
const WIRE_TYPE_LENGTH_DELIMITED = 2;
const WIRE_TYPE_FIXED32 = 5;

const GRPC_WEB_TRAILER_FLAG_BIT = 0x80;
const MAX_VARINT_SHIFT_BITS = 70n;

export function probeFrameHeader(
  buffer: Uint8Array,
  offset = 0,
): { flag: number; payloadStart: number; payloadLength: number } | null {
  if (offset + 5 > buffer.length) return null;
  const flag = buffer[offset];
  const b1 = buffer[offset + 1];
  const b2 = buffer[offset + 2];
  const b3 = buffer[offset + 3];
  const b4 = buffer[offset + 4];
  if (
    flag === undefined ||
    b1 === undefined ||
    b2 === undefined ||
    b3 === undefined ||
    b4 === undefined
  ) {
    return null;
  }
  const payloadLength = ((b1 << 24) | (b2 << 16) | (b3 << 8) | b4) >>> 0;
  return { flag, payloadStart: offset + 5, payloadLength };
}

function readVarint(buffer: Uint8Array, offset: number): { value: number; next: number } | null {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  for (;;) {
    if (pos >= buffer.length) return null;
    const byte = buffer[pos];
    if (byte === undefined) return null;
    result |= BigInt(byte & 0x7f) << shift;
    pos += 1;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
    if (shift > MAX_VARINT_SHIFT_BITS) return null;
  }
  return { value: Number(result), next: pos };
}

type ProtoField =
  | { wireType: typeof WIRE_TYPE_VARINT; value: number }
  | { wireType: typeof WIRE_TYPE_LENGTH_DELIMITED; bytes: Uint8Array }
  | { wireType: typeof WIRE_TYPE_FIXED32; bytes: Uint8Array }
  | { wireType: typeof WIRE_TYPE_FIXED64; bytes: Uint8Array };

function readLengthDelimitedField(
  buffer: Uint8Array,
  offset: number,
): { field: ProtoField; next: number } | null {
  const lengthResult = readVarint(buffer, offset);
  if (!lengthResult) return null;
  const { value: length, next: bodyStart } = lengthResult;
  if (length < 0 || bodyStart + length > buffer.length) return null;
  return {
    field: { wireType: WIRE_TYPE_LENGTH_DELIMITED, bytes: buffer.subarray(bodyStart, bodyStart + length) },
    next: bodyStart + length,
  };
}

function readFixedWidthField(
  buffer: Uint8Array,
  offset: number,
  width: number,
  wireType: typeof WIRE_TYPE_FIXED32 | typeof WIRE_TYPE_FIXED64,
): { field: ProtoField; next: number } | null {
  if (offset + width > buffer.length) return null;
  return {
    field: { wireType, bytes: buffer.subarray(offset, offset + width) },
    next: offset + width,
  };
}

function readField(
  buffer: Uint8Array,
  offset: number,
): { fieldNumber: number; field: ProtoField; next: number } | null {
  const tagResult = readVarint(buffer, offset);
  if (!tagResult) return null;
  const fieldNumber = tagResult.value >>> 3;
  const wireType = tagResult.value & 0x7;
  if (fieldNumber === 0) return null;

  if (wireType === WIRE_TYPE_VARINT) {
    const valueResult = readVarint(buffer, tagResult.next);
    if (!valueResult) return null;
    return {
      fieldNumber,
      field: { wireType: WIRE_TYPE_VARINT, value: valueResult.value },
      next: valueResult.next,
    };
  }
  if (wireType === WIRE_TYPE_LENGTH_DELIMITED) {
    const result = readLengthDelimitedField(buffer, tagResult.next);
    return result ? { fieldNumber, field: result.field, next: result.next } : null;
  }
  if (wireType === WIRE_TYPE_FIXED64) {
    const result = readFixedWidthField(buffer, tagResult.next, 8, WIRE_TYPE_FIXED64);
    return result ? { fieldNumber, field: result.field, next: result.next } : null;
  }
  if (wireType === WIRE_TYPE_FIXED32) {
    const result = readFixedWidthField(buffer, tagResult.next, 4, WIRE_TYPE_FIXED32);
    return result ? { fieldNumber, field: result.field, next: result.next } : null;
  }
  return null;
}

function decodeFields(buffer: Uint8Array): Map<number, ProtoField> | null {
  const fields = new Map<number, ProtoField>();
  let offset = 0;
  while (offset < buffer.length) {
    const result = readField(buffer, offset);
    if (!result) return null;
    fields.set(result.fieldNumber, result.field);
    offset = result.next;
  }
  return fields;
}

function findDataFramePayload(buffer: Uint8Array): Uint8Array | null {
  let offset = 0;
  while (offset < buffer.length) {
    const frame = probeFrameHeader(buffer, offset);
    if (!frame) return null;
    const frameEnd = frame.payloadStart + frame.payloadLength;
    const isTrailer = (frame.flag & GRPC_WEB_TRAILER_FLAG_BIT) !== 0;
    if (!isTrailer) {
      return buffer.subarray(frame.payloadStart, frameEnd);
    }
    offset = frameEnd;
  }
  return null;
}

function extractNestedMessage(field: ProtoField | undefined): Map<number, ProtoField> | null {
  if (!field || field.wireType !== WIRE_TYPE_LENGTH_DELIMITED) return null;
  return decodeFields(field.bytes);
}

function extractUsageRatio(field: ProtoField | undefined): number | null {
  if (!field) return 0; // proto3 omission = 0% used
  if (field.wireType === WIRE_TYPE_FIXED32) {
    const view = new DataView(field.bytes.buffer, field.bytes.byteOffset, field.bytes.byteLength);
    return view.getFloat32(0, true);
  }
  if (field.wireType === WIRE_TYPE_FIXED64) {
    const view = new DataView(field.bytes.buffer, field.bytes.byteOffset, field.bytes.byteLength);
    return view.getFloat64(0, true);
  }
  return null;
}

function extractResetAt(field: ProtoField | undefined): string | null {
  if (!field || field.wireType !== WIRE_TYPE_LENGTH_DELIMITED) return null;

  const timestampFields = decodeFields(field.bytes);
  if (!timestampFields) return null;

  const secondsField = timestampFields.get(TIMESTAMP_FIELD_SECONDS);
  const nanosField = timestampFields.get(TIMESTAMP_FIELD_NANOS);
  const seconds = secondsField?.wireType === WIRE_TYPE_VARINT ? secondsField.value : 0;
  const nanos = nanosField?.wireType === WIRE_TYPE_VARINT ? nanosField.value : 0;

  const millis = seconds * 1000 + Math.round(nanos / 1_000_000);
  const parsed = new Date(millis);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Decode GetGrokCreditsConfig response → `{ percentUsed: 0-100, resetAt }` or null.
 */
export function decodeGrokCreditsFrame(
  buffer: Uint8Array | null | undefined,
): { percentUsed: number; resetAt: string | null } | null {
  if (!buffer || buffer.length === 0) return null;
  const payload = findDataFramePayload(buffer);
  if (!payload) return null;

  const fields = decodeFields(payload);
  if (!fields) return null;

  const creditsInfo = fields.get(FIELD_CREDITS_INFO);
  if (!creditsInfo) return null;

  const nested = extractNestedMessage(creditsInfo);
  if (!nested) return null;

  const usageRatio = extractUsageRatio(nested.get(CREDITS_FIELD_USAGE_RATIO));
  if (usageRatio === null) return null;

  const resetAt = extractResetAt(nested.get(CREDITS_FIELD_RESET_TIMESTAMP));
  const percentUsed = Math.max(0, Math.min(100, Math.round(usageRatio * 100)));

  return { percentUsed, resetAt };
}
