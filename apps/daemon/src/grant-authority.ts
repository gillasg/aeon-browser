import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AuthHello, PageGrantScope } from "@aeon/protocol";

export type GrantRole = "extension-executor" | "ui";
export interface GrantContext {
  role: GrantRole;
  origin: string;
  clientInstanceId: string;
  browserRunId: string;
  pageInstanceId?: string;
  scope?: PageGrantScope;
}

interface GrantRecord extends GrantContext {
  expiresAt: number;
}

export type GrantCheck =
  | { ok: true; context: GrantContext }
  | {
      ok: false;
      code: "AUTHENTICATION_FAILED" | "GRANT_EXPIRED" | "ROLE_NOT_ALLOWED" | "SCOPE_MISMATCH";
    };

const EXECUTOR_TTL_MS = 15_000;
const PAGE_TTL_MS = 60_000;

export class GrantAuthority {
  private readonly grants = new Map<string, GrantRecord>();

  constructor(
    private readonly extensionOrigin: string,
    private readonly now: () => number = Date.now,
  ) {}

  issueExecutor(
    clientInstanceId: string,
    browserRunId: string,
  ): { token: string; expiresAt: number } {
    return this.issue(
      {
        role: "extension-executor",
        origin: this.extensionOrigin,
        clientInstanceId,
        browserRunId,
      },
      EXECUTOR_TTL_MS,
    );
  }

  issuePage(
    executor: GrantContext,
    pageInstanceId: string,
    scope: PageGrantScope,
  ): { token: string; expiresAt: number } | undefined {
    if (executor.role !== "extension-executor" || executor.origin !== this.extensionOrigin)
      return undefined;
    return this.issue(
      {
        role: "ui",
        origin: this.extensionOrigin,
        clientInstanceId: executor.clientInstanceId,
        browserRunId: executor.browserRunId,
        pageInstanceId,
        scope,
      },
      PAGE_TTL_MS,
    );
  }

  consume(origin: string, hello: AuthHello): GrantCheck {
    const key = this.digest(hello.connectionGrant);
    const record = this.grants.get(key);
    if (!record) return { ok: false, code: "AUTHENTICATION_FAILED" };
    this.grants.delete(key);
    if (record.expiresAt <= this.now()) return { ok: false, code: "GRANT_EXPIRED" };
    if (!safeEqual(record.origin, origin)) return { ok: false, code: "AUTHENTICATION_FAILED" };
    if (record.role !== hello.role) return { ok: false, code: "ROLE_NOT_ALLOWED" };
    if (
      record.clientInstanceId !== hello.clientInstanceId ||
      record.browserRunId !== hello.browserRunId
    )
      return { ok: false, code: "AUTHENTICATION_FAILED" };
    if (record.role === "ui" && record.pageInstanceId !== hello.pageInstanceId)
      return { ok: false, code: "SCOPE_MISMATCH" };
    return { ok: true, context: record };
  }

  reapExpired(): void {
    const now = this.now();
    for (const [key, grant] of this.grants) {
      if (grant.expiresAt <= now) this.grants.delete(key);
    }
  }

  private issue(context: GrantContext, ttl: number): { token: string; expiresAt: number } {
    this.reapExpired();
    const token = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + ttl;
    this.grants.set(this.digest(token), { ...context, expiresAt });
    return { token, expiresAt };
  }

  private digest(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("base64url");
  }
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
