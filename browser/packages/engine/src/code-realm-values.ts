// Values crossing out of a browser_code realm. A realm is its own JS world, so these checks never
// rely on instanceof against this process's constructors.

const tag = (value: unknown): string => Object.prototype.toString.call(value);

export function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  // page.url and page.title are callable strings; print them as the string they stand for.
  if (typeof value === "function" && Symbol.toPrimitive in value) return String(value);
  if (typeof value === "function")
    return `[Function ${(value as { name?: string }).name || "anonymous"}]`;
  try {
    return (
      JSON.stringify(
        value,
        (_key, item: unknown) => (typeof item === "bigint" ? String(item) : item),
        2,
      ) ?? String(value)
    );
  } catch {
    return String(value);
  }
}

/** Binary artifact data as bytes: typed arrays, ArrayBuffers, or byte arrays. */
function asBytes(data: unknown): Uint8Array {
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (tag(data) === "[object ArrayBuffer]") return new Uint8Array(data as ArrayBuffer);
  if (Array.isArray(data)) return Uint8Array.from(data as number[]);
  throw new Error(
    "artifact() takes a string, Uint8Array, ArrayBuffer or byte array; for a Blob, pass new Uint8Array(await blob.arrayBuffer())",
  );
}

export function encodeBytes(data: unknown): string {
  const bytes = asBytes(data);
  if (bytes.byteLength > 16_000_000) throw new Error("Binary artifact exceeds 16 MB; split it");
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

export function portable(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value);
  }
}
