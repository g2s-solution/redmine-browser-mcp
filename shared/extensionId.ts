import { createHash } from "node:crypto";

// Chrome derives an extension id from its public key: the first 128 bits of SHA-256 over the DER-encoded
// key, written with the letters a-p instead of the hex digits 0-f.
export function extensionIdFromKey(base64Key: string): string {
  const hex = createHash("sha256").update(Buffer.from(base64Key, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}
