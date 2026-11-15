// Chrome native messaging frames: 4-byte little-endian length, then exactly that many bytes.
// One request arrives per host process, and a supervisor connection carries one envelope, so a
// reader never needs to hand the bytes after a complete frame back to its caller.

export const MAX_MESSAGE_BYTES = 16384;

export class InvalidFrameError extends Error {}

export function encodeFrame(payload) {
  if (!Buffer.isBuffer(payload) || payload.length === 0 || payload.length > MAX_MESSAGE_BYTES)
    throw new InvalidFrameError("Native response length is outside its bound.");
  const header = Buffer.alloc(4);
  header.writeInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/** Reads one frame. Resolves null on a clean EOF before the header. */
export function readFrame(stream, options = {}) {
  const timeoutMs = options.timeoutMs ?? 0;
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      stream.off("close", onEnd);
      if (error) reject(error);
      else resolve(value);
    };
    const fail = (code) =>
      finish(
        new InvalidFrameError(
          code === "EXCEEDS_LIMIT"
            ? "Native message length is outside its bound."
            : "Native message ended before its declared size.",
        ),
      );
    const onData = (chunk) => {
      buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readInt32LE(0);
      if (length <= 0 || length > MAX_MESSAGE_BYTES) return fail("EXCEEDS_LIMIT");
      if (buffer.length < 4 + length) return;
      finish(undefined, buffer.subarray(4, 4 + length));
    };
    const onEnd = () =>
      buffer.length === 0
        ? finish(undefined, null)
        : fail("Native message ended before its declared size.");
    const onError = (error) => finish(error);
    const timer =
      timeoutMs > 0
        ? setTimeout(() => finish(new Error("Timed out reading a frame.")), timeoutMs)
        : undefined;
    timer?.unref?.();
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("close", onEnd);
    stream.once("error", onError);
  });
}

/** Writes one frame and resolves once the stream has taken it. */
export function writeFrame(stream, payload) {
  const frame = encodeFrame(payload);
  return new Promise((resolve, reject) => {
    stream.write(frame, (error) => (error ? reject(error) : resolve()));
  });
}
