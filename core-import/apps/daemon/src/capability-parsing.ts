import type {
  CapabilityDefinition,
  CapabilityRegistryFile,
  CapabilityVerification,
} from "@aeon/domain";

export const REGISTRY_SCHEMA_VERSION = 1;
export const MAX_CAPABILITIES = 100;

type CapabilityFields = Pick<
  CapabilityDefinition,
  | "id"
  | "displayName"
  | "description"
  | "configReference"
  | "credentialReference"
  | "relatedSkillIds"
  | "verification"
>;

export function parseCapability(
  input: unknown,
  preserveVerification = false,
): CapabilityDefinition {
  if (!isRecord(input)) throw new Error("Capability must be an object.");
  const base: CapabilityFields = {
    id: readString(input, "id", 64),
    displayName: readString(input, "displayName", 120),
    description: readString(input, "description", 1000),
    configReference: readString(input, "configReference", 200),
    credentialReference: readCredentialReference(input.credentialReference),
    relatedSkillIds: readStringArray(input.relatedSkillIds, 20, 100),
    verification: preserveVerification ? parseVerification(input.verification) : needsCheck(),
  };
  if (!/^cap_[a-z0-9][a-z0-9_-]{0,58}$/.test(base.id))
    throw new Error(
      "Capability id must start with cap_ and use lowercase letters, digits, _ or -.",
    );
  if (input.kind === "cli") return parseCliCapability(input, base);
  if (input.kind === "mcp") return parseMcpCapability(input, base);
  throw new Error("Capability kind must be cli or mcp.");
}

function parseCliCapability(
  input: Record<string, unknown>,
  base: CapabilityFields,
): CapabilityDefinition {
  if (!isRecord(input.launcher)) throw new Error("CLI capability needs a launcher.");
  return {
    ...base,
    kind: "cli",
    launcher: {
      executable: readString(input.launcher, "executable", 300),
      workingDirectory: nullableString(input.launcher.workingDirectory, 1000),
    },
  };
}

function parseMcpCapability(
  input: Record<string, unknown>,
  base: CapabilityFields,
): CapabilityDefinition {
  const transport = input.transport;
  const command = nullableString(input.command, 300);
  const endpoint = nullableString(input.endpoint, 2000);
  const args = readStringArray(input.args ?? [], 64, 1000);
  const workingDirectory = nullableString(input.workingDirectory, 1000);
  if (transport === "stdio") {
    if (!command || endpoint)
      throw new Error("stdio MCP capability needs command and no endpoint.");
    validateSafeArguments(args);
  } else if (transport === "streamable-http") {
    if (command || !endpoint)
      throw new Error("Streamable HTTP MCP capability needs an endpoint and no command.");
    if (args.length)
      throw new Error("Streamable HTTP MCP capability does not use command arguments.");
    validateEndpoint(endpoint);
  } else {
    throw new Error("MCP transport must be stdio or streamable-http.");
  }
  return {
    ...base,
    kind: "mcp",
    transport,
    command,
    args,
    endpoint,
    workingDirectory,
  };
}

export function parseRegistry(raw: string): CapabilityRegistryFile {
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("capabilities.json contains invalid JSON; the existing file was preserved.");
  }
  if (
    !isRecord(candidate) ||
    candidate.schemaVersion !== REGISTRY_SCHEMA_VERSION ||
    !Number.isSafeInteger(candidate.revision) ||
    (candidate.revision as number) < 0 ||
    !Array.isArray(candidate.capabilities) ||
    candidate.capabilities.length > MAX_CAPABILITIES
  )
    throw new Error("capabilities.json has an unsupported schema or revision.");
  const capabilities = candidate.capabilities.map((item) => parseCapability(item, true));
  if (new Set(capabilities.map(({ id }) => id)).size !== capabilities.length)
    throw new Error("capabilities.json contains duplicate capability IDs.");
  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    revision: candidate.revision as number,
    capabilities,
  };
}

function parseVerification(value: unknown): CapabilityVerification {
  if (!isRecord(value)) throw new Error("Capability verification metadata is invalid.");
  if (!["needs_check", "verified", "failed"].includes(String(value.state)))
    throw new Error("Capability verification state is invalid.");
  const checkedAt = nullableString(value.checkedAt, 40);
  if (checkedAt && !Number.isFinite(Date.parse(checkedAt)))
    throw new Error("Capability verification timestamp is invalid.");
  return {
    state: value.state as CapabilityVerification["state"],
    checkedAt,
    summary: nullableString(value.summary, 300),
  };
}

export function needsCheck(): CapabilityVerification {
  return { state: "needs_check", checkedAt: null, summary: null };
}

function readCredentialReference(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== "string" ||
    !(
      /^env:[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value) ||
      value === "external-config-only" ||
      /^external:[A-Za-z0-9._:-]{1,120}$/.test(value)
    )
  )
    throw new Error(
      "credentialReference must be null or a non-secret external credential reference.",
    );
  return value;
}

function validateSafeArguments(args: string[]): void {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (/^--?(?:token|secret|password|api[-_]?key)(?:=|$)/i.test(argument))
      throw new Error("MCP arguments cannot contain secret-bearing option names or values.");
  }
}

function validateEndpoint(value: string): void {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
    throw new Error(
      "MCP endpoint must be an explicit HTTP(S) URL without credentials or a fragment.",
    );
  if (
    [...url.searchParams.keys()].some((key) => /token|secret|password|api[-_]?key|auth/i.test(key))
  )
    throw new Error("MCP endpoint query parameters cannot carry credentials.");
}

function readString(input: Record<string, unknown>, key: string, max: number): string {
  return requiredString(input[key], max, key);
}

function requiredString(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`${label} must contain 1–${max} characters.`);
  const normalized = value.trim();
  if (/(?:api[-_ ]?key|access[-_ ]?token|token|secret|password)\s*[:=]\s*[^\s]+/i.test(normalized))
    throw new Error(`${label} cannot contain an inline credential value.`);
  return normalized;
}

function nullableString(value: unknown, max: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  return requiredString(value, max, "value");
}

function readStringArray(value: unknown, maxItems: number, maxString: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems)
    throw new Error(`Array must contain no more than ${maxItems} strings.`);
  return value.map((item) => requiredString(item, maxString, "array item"));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
