import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { dataDirectory } from "./paths.mjs";

const MAX_CONFIG_BYTES = 16384;
const KNOWN_KEYS = new Set([
  "extensionId",
  "nodeExecutable",
  "daemonEntrypoint",
  "dataDirectory",
  "current",
  "previous",
  "channel",
]);
const EXTENSION_ID = /^[a-p]{32}$/;

export class HostConfigError extends Error {}

/** Reads the host configuration, retrying a partial write the way the C# host does. */
export async function loadConfig(path, options = {}) {
  const attempts = options.attempts ?? 6;
  const delayMs = options.delayMs ?? 100;
  let last;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return readConfig(path, options);
    } catch (error) {
      last = error;
      if (!retryable(error) || attempt === attempts - 1) break;
      await new Promise((done) => setTimeout(done, delayMs));
    }
  }
  throw last;
}

function retryable(error) {
  return (
    error instanceof HostConfigError &&
    (error.code === "ENOENT" || error.code === "PARTIAL" || error.code === "EACCES")
  );
}

export function readConfig(path, options = {}) {
  let text;
  try {
    if (statSync(path).size < 2) throw partial("Native host config is missing or too small.");
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof HostConfigError) throw error;
    throw partial("Native host config is missing or unreadable.", error);
  }
  if (text.length > MAX_CONFIG_BYTES) throw invalid("Native host config is too large.");
  let values;
  try {
    values = JSON.parse(text);
  } catch (error) {
    throw partial("Native host config is not valid JSON.", error);
  }
  if (!values || typeof values !== "object" || Array.isArray(values))
    throw invalid("Native host config has an unsupported shape.");
  for (const key of Object.keys(values))
    if (!KNOWN_KEYS.has(key)) throw invalid("Unknown config key.");
  const config = {
    extensionId: required(values, "extensionId"),
    nodeExecutable: resolve(required(values, "nodeExecutable")),
    daemonEntrypoint: resolve(required(values, "daemonEntrypoint")),
    dataDirectory: resolve(required(values, "dataDirectory")),
    ...optional(values, "current"),
    ...optional(values, "previous"),
    ...optional(values, "channel"),
  };
  validate(config, options);
  return config;
}

function validate(config, options) {
  if (!EXTENSION_ID.test(config.extensionId))
    throw invalid("Native host config has an invalid extension ID.");
  if (!existsSync(config.nodeExecutable))
    throw invalid("The configured Node executable is missing.");
  config.daemonEntrypoint = entrypoint(config.daemonEntrypoint);
  const dataRoot = dataDirectory(options);
  const data = relative(dataRoot, config.dataDirectory);
  if (data.startsWith("..") || isAbsolute(data))
    throw invalid("Daemon data must live under " + dataRoot + ".");
  mkdirSync(config.dataDirectory, { recursive: true, mode: 0o700 });
}

/** A versioned build may be the daemon file or its directory; the directory launches main.js. */
function entrypoint(path) {
  if (existsSync(path) && statSync(path).isFile()) return path;
  const nested = join(path, "main.js");
  if (existsSync(nested)) return nested;
  throw invalid("A configured native host file is missing.");
}

function required(values, key) {
  const value = values[key];
  if (typeof value !== "string" || !value.trim())
    throw invalid("Native host config has an invalid path or ID.");
  return value;
}

function optional(values, key) {
  if (!(key in values)) return {};
  return { [key]: required(values, key) };
}

function invalid(message) {
  return new HostConfigError(message);
}

function partial(message, cause) {
  const error = new HostConfigError(message);
  error.code = cause?.code === "ENOENT" ? "ENOENT" : "PARTIAL";
  return error;
}

export { MAX_CONFIG_BYTES };
