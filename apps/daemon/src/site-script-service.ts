import { randomUUID } from "node:crypto";
import type { SiteScriptRecord, SiteScriptRevision } from "@pippin/domain";
import { SqliteSiteScriptStore } from "@pippin/store";
import {
  SiteScriptCommandSchema,
  SiteScriptDefinitionSchema,
  type SiteScriptCommand,
  type BrowserTargetKey,
} from "@pippin/protocol";
import type { WebSocket } from "ws";
import type { BrowserControlService } from "./browser-control-service.js";

export class SiteScriptService {
  private readonly store: SqliteSiteScriptStore;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    directory: string,
    private readonly browser: BrowserControlService,
  ) {
    this.store = new SqliteSiteScriptStore(directory);
  }
  execute(chatId: string, callId: string, input: unknown, signal?: AbortSignal): Promise<string> {
    const next = this.chain
      .catch(() => undefined)
      .then(async () => {
        try {
          return JSON.stringify(
            await this.run(chatId, callId, SiteScriptCommandSchema.parse(input), signal),
          );
        } catch (error) {
          return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
        }
      });
    this.chain = next;
    return next;
  }
  sync(clientInstanceId: string, socket: WebSocket): void {
    socket.send(
      JSON.stringify({
        kind: "browser.scripts.sync",
        scripts: this.store
          .list()
          .filter((script) => script.clientInstanceId === clientInstanceId)
          .map((script) => SiteScriptDefinitionSchema.parse(this.definition(script))),
      }),
    );
  }
  close(): void {
    this.store.close();
  }
  private async run(
    chatId: string,
    callId: string,
    command: SiteScriptCommand,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (signal?.aborted) throw new Error("CANCELLED");
    const existing = command.scriptId ? this.store.get(command.scriptId) : undefined;
    if (command.action === "list" || command.action === "get") return this.query(command, existing);
    if (command.action === "status") {
      if (!existing || !command.target)
        throw new Error("Provide scriptId and the attached target.");
      this.validateTarget(chatId, existing.matches, command.target);
      if (command.target.clientInstanceId !== existing.clientInstanceId)
        throw new Error("Script belongs to a different Chrome instance.");
      return JSON.parse(
        await this.browser.execute(
          chatId,
          callId,
          {
            steps: [
              {
                op: "siteScript",
                action: "status",
                target: command.target,
                scriptId: existing.scriptId,
              },
            ],
          },
          signal,
        ),
      );
    }
    if (["preview", "save"].includes(command.action))
      return this.createAndApply(chatId, callId, command, signal);
    this.validateChange(chatId, command, existing);
    if (!existing) throw new Error("Site script not found.");
    return this.change(callId, { ...existing, chatId }, command, signal);
  }
  private validateChange(
    chatId: string,
    command: SiteScriptCommand,
    existing?: SiteScriptRecord,
  ): void {
    if (!existing) throw new Error("Site script not found.");
    if (command.expectedRevision !== existing.revision)
      throw new Error("Read the current script and provide expectedRevision before changing it.");
    if (command.target && command.target.clientInstanceId !== existing.clientInstanceId)
      throw new Error("Script belongs to a different Chrome instance.");
    if (command.matches && !command.target)
      throw new Error("Provide an attached target to change matching sites.");
    if (command.target)
      this.validateTarget(chatId, command.matches ?? existing.matches, command.target);
  }
  private query(command: SiteScriptCommand, existing?: SiteScriptRecord): unknown {
    if (command.action === "list")
      return {
        scripts: this.store.list().map((script) => ({
          scriptId: script.scriptId,
          name: script.name,
          matches: script.matches,
          revision: script.revision,
          enabled: script.enabled,
          clientInstanceId: script.clientInstanceId,
        })),
      };
    return {
      script: existing
        ? {
            ...this.definition(existing),
            history: existing.history.map((item) => ({
              revision: item.revision,
              name: item.name,
              createdAt: item.createdAt,
            })),
          }
        : null,
    };
  }
  private async createAndApply(
    chatId: string,
    callId: string,
    command: SiteScriptCommand,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const script = this.create(chatId, command);
    this.validateTarget(chatId, script.matches, command.target);
    if (this.store.get(script.scriptId)) throw new Error("Script already exists; use update.");
    if (command.action === "save") {
      if (this.store.list().length >= 100) throw new Error("Site script limit reached (100).");
      this.store.put(script);
    }
    const result = await this.apply(
      callId,
      script,
      command.target,
      command.action === "preview" ? "preview" : "install",
      signal,
    );
    if (command.action === "save") this.browser.resyncScripts(script.clientInstanceId);
    return result;
  }
  private create(chatId: string, command: SiteScriptCommand): SiteScriptRecord {
    if (!command.target || !command.name || !command.matches)
      throw new Error("Provide target, name, and matches.");
    if (!command.code?.trim() && !command.css?.trim())
      throw new Error("Provide JavaScript code or CSS.");
    return {
      scriptId: command.scriptId ?? randomUUID(),
      clientInstanceId: command.target.clientInstanceId,
      chatId,
      revision: 1,
      name: command.name,
      matches: command.matches,
      code: command.code ?? "",
      css: command.css ?? "",
      enabled: true,
      createdAt: new Date().toISOString(),
      history: [],
    };
  }
  private async change(
    callId: string,
    script: SiteScriptRecord,
    command: SiteScriptCommand,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (command.action === "delete") {
      this.store.delete(script.scriptId);
      const runtime = await this.remove(callId, script, command.target, signal);
      this.browser.resyncScripts(script.clientInstanceId);
      return { deleted: true, runtime };
    }
    const previous: SiteScriptRevision = {
      revision: script.revision,
      name: script.name,
      matches: script.matches,
      code: script.code,
      css: script.css,
      createdAt: script.createdAt,
    };
    const next = this.revise(script, command, previous);
    if (!next.code.trim() && !next.css.trim()) throw new Error("Provide JavaScript code or CSS.");
    if (command.target) this.validateTarget(script.chatId, next.matches, command.target);
    this.store.put(next);
    const runtime = next.enabled
      ? await this.apply(callId, next, command.target, "install", signal)
      : await this.remove(callId, next, command.target, signal);
    this.browser.resyncScripts(next.clientInstanceId);
    return { scriptId: next.scriptId, revision: next.revision, enabled: next.enabled, runtime };
  }
  private revise(
    script: SiteScriptRecord,
    command: SiteScriptCommand,
    previous: SiteScriptRevision,
  ): SiteScriptRecord {
    const restored = command.action === "undo" ? script.history.at(-1) : undefined;
    if (command.action === "undo" && !restored) throw new Error("No earlier revision.");
    const patch: Partial<SiteScriptCommand> = updatePatch(command);
    const value = restored ?? {
      name: patch.name ?? script.name,
      matches: patch.matches ?? script.matches,
      code: patch.code ?? script.code,
      css: patch.css ?? script.css,
    };
    return {
      ...script,
      ...value,
      revision: script.revision + 1,
      createdAt: new Date().toISOString(),
      enabled:
        command.action === "disable" ? false : command.action === "enable" ? true : script.enabled,
      history:
        command.action === "undo"
          ? script.history.slice(0, -1)
          : [...script.history, previous].slice(-20),
    };
  }
  private async apply(
    callId: string,
    script: SiteScriptRecord,
    target: BrowserTargetKey | undefined,
    action: "preview" | "install",
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!target) {
      this.browser.resyncScripts(script.clientInstanceId);
      return { pendingBrowser: true };
    }
    const result = await this.browser.execute(
      script.chatId,
      callId,
      { steps: [{ op: "siteScript", target, action, definition: this.definition(script) }] },
      signal,
    );
    return {
      scriptId: script.scriptId,
      revision: script.revision,
      saved: action === "install",
      runtime: JSON.parse(result),
    };
  }
  private async remove(
    callId: string,
    script: SiteScriptRecord,
    target?: BrowserTargetKey,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!target) return { cleanupOnReconnect: true };
    return JSON.parse(
      await this.browser.execute(
        script.chatId,
        callId,
        { steps: [{ op: "siteScript", target, action: "remove", scriptId: script.scriptId }] },
        signal,
      ),
    );
  }
  private validateTarget(chatId: string, matches: string[], target?: BrowserTargetKey): void {
    if (!target) throw new Error("Attach a browser target before creating a script.");
    const origin = new URL(this.browser.targetUrl(chatId, target)).origin;
    for (const match of matches) {
      const parsed = new URL(match);
      if (parsed.origin !== origin || parsed.username || parsed.password)
        throw new Error(
          "Matches must use the attached page origin. Attach another site to create its script.",
        );
    }
  }
  private definition(script: SiteScriptRecord): import("@pippin/protocol").SiteScriptDefinition {
    return {
      scriptId: script.scriptId,
      revision: script.revision,
      name: script.name,
      matches: script.matches,
      code: script.code,
      css: script.css,
      enabled: script.enabled,
    };
  }
}

function updatePatch(command: SiteScriptCommand): Partial<SiteScriptCommand> {
  return command.action === "update" ? command : {};
}
