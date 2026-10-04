import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("../vendor/", import.meta.url));
const provenance = JSON.parse(await readFile(join(directory, "protocol-origin.json"), "utf8"));
if (dirname(provenance.file) !== ".") throw new Error("Invalid protocol artifact filename");
const actual = createHash("sha256")
  .update(await readFile(join(directory, provenance.file)))
  .digest("hex");
if (actual !== provenance.sha256) throw new Error("Protocol artifact checksum mismatch");
process.stdout.write("Pinned Core protocol checksum verified.\n");
