// A small PNG reader for screenshot probes: 8-bit RGB or RGBA, non-interlaced, all five filters.
// That is every PNG Chrome writes, and it keeps the sweep free of image dependencies.
import { inflateSync } from "node:zlib";

export function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const data = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, colour, , , interlace] = body.subarray(8, 13);
      if (depth !== 8 || interlace !== 0 || (colour !== 2 && colour !== 6))
        throw new Error(
          `unsupported PNG (depth ${depth}, colour ${colour}, interlace ${interlace})`,
        );
      channels = colour === 6 ? 4 : 3;
    } else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  const pixels = unfilter(inflateSync(Buffer.concat(data)), width, height, channels);
  return {
    type: "png",
    width,
    height,
    pixel(x, y) {
      const at = (y * width + x) * channels;
      return [pixels[at], pixels[at + 1], pixels[at + 2]];
    },
  };
}

function unfilter(raw, width, height, channels) {
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? out[y * stride + x - channels] : 0;
      const up = y > 0 ? out[(y - 1) * stride + x] : 0;
      const corner = y > 0 && x >= channels ? out[(y - 1) * stride + x - channels] : 0;
      out[y * stride + x] = (line[x] + predict(filter, left, up, corner)) & 0xff;
    }
  }
  return out;
}

function predict(filter, left, up, corner) {
  if (filter === 0) return 0;
  if (filter === 1) return left;
  if (filter === 2) return up;
  if (filter === 3) return (left + up) >> 1;
  const p = left + up - corner;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - corner);
  return pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
}
