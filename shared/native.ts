// Chrome Native Messaging framing: a 4-byte little-endian length, then that many bytes of UTF-8 JSON.
// Chrome rejects a single message from the host larger than 1 MiB.
export const MAX_HOST_MESSAGE_BYTES = 1024 * 1024;

export function encodeFrame(json: string, maxBytes = MAX_HOST_MESSAGE_BYTES): Buffer {
  const body = Buffer.from(json, "utf8");
  if (body.length > maxBytes)
    throw new Error(`native message of ${body.length} bytes exceeds the ${maxBytes} byte limit`);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

export class FrameDecoder {
  private buffer = Buffer.alloc(0);

  constructor(private maxBytes = 64 * 1024 * 1024) {}

  push(chunk: Buffer): string[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const out: string[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > this.maxBytes)
        throw new Error(`native frame of ${length} bytes exceeds the ${this.maxBytes} byte limit`);
      if (this.buffer.length < 4 + length) break;
      out.push(this.buffer.subarray(4, 4 + length).toString("utf8"));
      this.buffer = this.buffer.subarray(4 + length);
    }
    return out;
  }
}
