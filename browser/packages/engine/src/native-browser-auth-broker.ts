// The sign-in broker: one place that hands a page its password, one-time code or passkey, so the
// agent only ever sees the outcome. One-time codes come from the password manager (through
// @browserkit/credentials' `totp` request) or, for an entry the user opted into the local vault,
// from an RFC 6238 generator here (WebCrypto HMAC, no dependencies). A virtual WebAuthn
// authenticator is created only when asked: until then no WebAuthn command is ever sent.
// Seeds, codes and passkey material never enter a result, a trace or a log line.

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(input: string): Uint8Array {
  const clean = input.replace(/[\s=-]/g, "").toUpperCase();
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error("TOTP_SEED: the seed is not base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export interface TotpOptions {
  /** Unix ms; now by default. */
  time?: number | undefined;
  stepSeconds?: number | undefined;
  digits?: number | undefined;
  algorithm?: "SHA-1" | "SHA-256" | "SHA-512" | undefined;
}

/** RFC 6238 TOTP (RFC 4226 HOTP over a time counter) from raw key bytes. */
export async function totpFromKey(key: Uint8Array, options: TotpOptions = {}): Promise<string> {
  const step = options.stepSeconds ?? 30;
  const digits = options.digits ?? 6;
  const counter = Math.floor((options.time ?? Date.now()) / 1000 / step);
  const message = new Uint8Array(8);
  new DataView(message.buffer).setBigUint64(0, BigInt(counter));
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: options.algorithm ?? "SHA-1" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", cryptoKey, message));
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function totp(seedBase32: string, options: TotpOptions = {}): Promise<string> {
  return totpFromKey(base32Decode(seedBase32), options);
}

/** Replaces every known secret (seed, code, passkey material) of 4+ characters in text. */
export function redactSecrets(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const secret of secrets)
    if (secret && secret.length >= 4) out = out.split(secret).join("[redacted]");
  return out;
}

export type CdpSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

export interface LocalTotpEntry {
  id: string;
  /** The user opted this entry in; others are never read. */
  optedIn: boolean;
  seed: string;
  digits?: number;
  stepSeconds?: number;
  algorithm?: TotpOptions["algorithm"];
}

export interface AuthBrokerDeps {
  /** The password manager's answer to a `{credential: "totp", url, id}` request. */
  managerTotp?: (url: string, id: string) => Promise<string | undefined>;
  localEntries?: () => Promise<LocalTotpEntry[]>;
  /** Types a code into the page; the broker never returns it. */
  fill?: (code: string) => Promise<void>;
  now?: () => number;
}

export interface OtpOutcome {
  filled: boolean;
  source: "manager" | "local" | "none";
  digits?: number;
  validForSeconds?: number;
}

export class AuthBroker {
  readonly #deps: AuthBrokerDeps;
  readonly #secrets = new Set<string>();
  #webauthn: { authenticatorId: string; send: CdpSend } | undefined;

  constructor(deps: AuthBrokerDeps = {}) {
    this.#deps = deps;
  }

  /** Fills a one-time code for the entry; the result says where it came from, never what it is. */
  async fillOtp(url: string, id: string): Promise<OtpOutcome> {
    const now = this.#deps.now?.() ?? Date.now();
    let code = await this.#deps.managerTotp?.(url, id).catch(() => undefined);
    let source: OtpOutcome["source"] = code ? "manager" : "none";
    let step = 30;
    if (!code) {
      const entry = (await this.#deps.localEntries?.())?.find((e) => e.id === id && e.optedIn);
      if (entry) {
        this.#secrets.add(entry.seed);
        step = entry.stepSeconds ?? 30;
        code = await totp(entry.seed, {
          time: now,
          digits: entry.digits,
          stepSeconds: step,
          algorithm: entry.algorithm,
        });
        source = "local";
      }
    }
    if (!code) return { filled: false, source: "none" };
    this.#secrets.add(code);
    if (this.#deps.fill) await this.#deps.fill(code);
    return {
      filled: Boolean(this.#deps.fill),
      source,
      digits: code.length,
      validForSeconds: step - (Math.floor(now / 1000) % step),
    };
  }

  /** A virtual passkey authenticator on the tab; WebAuthn.enable is sent here and nowhere else. */
  async enablePasskeys(send: CdpSend, options: { userVerified?: boolean } = {}) {
    if (this.#webauthn) return { enabled: true, reused: true };
    await send("WebAuthn.enable", { enableUI: false });
    const added = (await send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: options.userVerified !== false,
        automaticPresenceSimulation: true,
      },
    })) as { authenticatorId?: string };
    if (!added?.authenticatorId)
      throw new Error("WEBAUTHN: the browser did not create an authenticator");
    this.#webauthn = { authenticatorId: added.authenticatorId, send };
    return { enabled: true, reused: false };
  }

  /** How many passkeys the virtual authenticator holds; ids and keys stay inside. */
  async passkeyCount(): Promise<number> {
    if (!this.#webauthn) return 0;
    const answer = (await this.#webauthn.send("WebAuthn.getCredentials", {
      authenticatorId: this.#webauthn.authenticatorId,
    })) as { credentials?: { privateKey?: string; credentialId?: string }[] };
    for (const credential of answer?.credentials ?? []) {
      if (credential.privateKey) this.#secrets.add(credential.privateKey);
      if (credential.credentialId) this.#secrets.add(credential.credentialId);
    }
    return answer?.credentials?.length ?? 0;
  }

  async disablePasskeys(): Promise<{ disabled: boolean }> {
    const current = this.#webauthn;
    if (!current) return { disabled: false };
    this.#webauthn = undefined;
    await current
      .send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: current.authenticatorId })
      .catch(() => undefined);
    await current.send("WebAuthn.disable").catch(() => undefined);
    return { disabled: true };
  }

  get passkeysEnabled(): boolean {
    return this.#webauthn !== undefined;
  }

  /** Any text leaving the broker's caller (a log, a trace, an error) goes through this first. */
  redact(text: string): string {
    return redactSecrets(text, this.#secrets);
  }
}
