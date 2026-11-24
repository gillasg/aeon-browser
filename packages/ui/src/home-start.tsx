import { PageContextTray } from "./page-context-tray.js";
import { usePanelPage } from "./panel-page-chip.js";
import { ProjectChip } from "./project-chip.js";
import { QuietWait } from "./pending-work.js";
import {
  useHomeAttachments,
  HomeAttachmentPicker,
  HomeAttachmentList,
} from "./home-attachments.js";
import { useState, type FormEvent, type ReactElement, useEffect } from "react";
import type { PiModelCatalogDto } from "@aeon/protocol";
import type { ComposerModel } from "./chat-composer.js";
import { PiModelPicker, PiThinkingPicker, modelKey } from "./pi-model-picker.js";
import { ConnectModelCard, type ModelLoginState } from "./connect-model-card.js";
import { NewUserWelcome, markWelcomeDone } from "./new-user-welcome.js";
import { PromptField } from "./prompt-field.js";
import { ReadinessStrip } from "./readiness-strip.js";
import { platformName } from "./platform.js";
import type { NewTabHomeProps } from "./home-surface.js";

type HomeStartProps = Pick<
  NewTabHomeProps,
  "modelCatalog" | "modelLogin" | "onConnectModel" | "onAsk" | "onReadAttachments"
> & {
  projectName?: string | null;
  projectId?: string | null;
  browserContext?: import("@aeon/protocol").PiBrowserContextRecord | null;
  onRemoveContext?(): void;
  chatId?: string;
  connected?: boolean;
  /** Optional Chrome flags the daemon saw missing; drives the quiet relaunch notice. */
  missingChromeFlags?: readonly string[] | undefined;
  /** "What can Aeon do?": the Learn page. */
  onLearn?(): void;
};

export function HomeStart({ props }: { props: HomeStartProps }): ReactElement {
  const panelPage = usePanelPage();
  const [query, setQuery] = useState("");
  useHomeSeed(setQuery);
  const files = useHomeAttachments(props.onReadAttachments);
  const selection = useHomeSelection(props.modelCatalog);
  const ask = (value: string): void => {
    if (selection.model)
      props.onAsk(value, selection.model, selection.thinkingLevel, files.attachments);
  };
  const tryExample = (text: string): void => {
    setQuery(text);
    focusQuery();
  };
  const needsModel = needsModelConnect(props);
  return (
    <section className="home-start" aria-label="Ask Aeon">
      <p className="home-idle-line">Do anything on {pageHost(panelPage.record?.url)}</p>
      <NewUserWelcome needsModel={needsModel} onExample={tryExample} onLearn={props.onLearn} />
      <ProjectChip name={props.projectName} projectId={props.projectId} />
      <PageContextTray
        chatId={props.chatId}
        primary={props.browserContext ?? panelPage.record}
        onRemove={() => {
          panelPage.remove();
          props.onRemoveContext?.();
        }}
      />
      <HomeAttachmentList state={files} />
      <HomePrompt
        contextId={props.chatId}
        query={query}
        onQuery={setQuery}
        canSubmit={Boolean(
          props.connected !== false && selection.model && selection.thinkingLevel && !files.loading,
        )}
        onSubmit={ask}
        onFiles={(items) => void files.add(items)}
      />
      <ReadinessStrip
        connected={props.connected}
        missingChromeFlags={props.missingChromeFlags}
        platform={platformName}
      />
      <HomeModelControls
        connected={props.connected}
        modelLogin={props.modelLogin}
        onConnectModel={props.onConnectModel}
        catalog={props.modelCatalog}
        model={selection.model}
        effort={selection.thinkingLevel}
        onModel={selection.setModel}
        onEffort={selection.setEffort}
      />
    </section>
  );
}

function useHomeSeed(setQuery: (value: string) => void): void {
  // The ⌘K palette puts a site action in the ask box ("aeon.home.seed").
  useEffect(() => {
    const seed = (event: Event): void => {
      setQuery(String((event as CustomEvent<string>).detail ?? ""));
      focusQuery();
    };
    window.addEventListener("aeon.home.seed", seed);
    return () => window.removeEventListener("aeon.home.seed", seed);
  }, []);
}

function focusQuery(): void {
  requestAnimationFrame(() => document.getElementById("home-query")?.focus());
}

function useHomeSelection(catalog: PiModelCatalogDto | null) {
  const [modelSelection, setModelSelection] = useState("");
  const [effortSelections, setEffortSelections] = useState<Record<string, string>>({});
  const model =
    catalog?.models.find((candidate) => modelKey(candidate) === modelSelection) ??
    catalog?.models.find(
      (candidate) =>
        candidate.provider === catalog.defaultModel?.provider &&
        candidate.id === catalog.defaultModel?.id,
    ) ??
    null;
  const selectedEffort = model ? effortSelections[modelKey(model)] : undefined;
  const thinkingLevel = model
    ? selectedEffort && model.thinkingLevels.includes(selectedEffort)
      ? selectedEffort
      : model.defaultThinkingLevel
    : "";
  return {
    model,
    thinkingLevel,
    setModel: (value: ComposerModel) => setModelSelection(modelKey(value)),
    setEffort: (level: string) => {
      if (model) setEffortSelections((current) => ({ ...current, [modelKey(model)]: level }));
    },
  };
}

function HomePrompt({
  query,
  onQuery,
  canSubmit,
  onSubmit,
  onFiles,
  contextId,
}: {
  query: string;
  onQuery(value: string): void;
  canSubmit: boolean;
  onSubmit(value: string): void;
  onFiles(files: readonly File[]): void;
  contextId?: string | undefined;
}): ReactElement {
  // Any sent task, typed or picked, retires the first-run examples.
  const send = (): void => {
    if (!query.trim() || !canSubmit) return;
    markWelcomeDone();
    onSubmit(query.trim());
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    send();
  };
  return (
    <form id="home-form" className="home-query-form" onSubmit={submit}>
      <HomeAttachmentPicker onFiles={onFiles} contextId={contextId} />
      <PromptField
        multiline
        id="home-query"
        // The Manage tab never takes the keyboard on load; the side panel's start page does.
        autoFocus={inPanel()}
        value={query}
        placeholder="Ask Aeon to do anything"
        ariaLabel="Ask Aeon anything"
        onChange={onQuery}
        onFiles={onFiles}
        onEnter={send}
      />
      <button
        className="home-send-button"
        type="submit"
        aria-label="Ask Aeon"
        disabled={!query.trim() || !canSubmit}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M10 15V4m0 0L5.7 8.3M10 4l4.3 4.3" />
        </svg>
      </button>
    </form>
  );
}

function HomeModelControls({
  connected,
  modelLogin,
  onConnectModel,
  catalog,
  model,
  effort,
  onModel,
  onEffort,
}: {
  connected: boolean | undefined;
  modelLogin: ModelLoginState | undefined;
  onConnectModel: (() => void) | undefined;
  catalog: PiModelCatalogDto | null;
  model: ComposerModel | null;
  effort: string;
  onModel(value: ComposerModel): void;
  onEffort(value: string): void;
}): ReactElement {
  // While connecting, the swarm above the field is the only sign; this row stays empty.
  if (connected === false)
    return (
      <div className="home-model-controls" role="status">
        <span className="aeon-sr">Connecting…</span>
      </div>
    );
  if (catalog && !catalog.models.length && onConnectModel)
    return <ConnectModelCard state={modelLogin ?? { waiting: false }} onConnect={onConnectModel} />;
  return (
    <>
      <HomePickers
        catalog={catalog}
        model={model}
        effort={effort}
        onModel={onModel}
        onEffort={onEffort}
        onConnectModel={onConnectModel}
      />
      {modelLogin?.error && (
        <div className="connect-model" role="alert">
          <div className="connect-model-body">
            <p className="connect-model-error">{modelLogin.error}</p>
          </div>
        </div>
      )}
    </>
  );
}

function HomePickers({
  catalog,
  model,
  effort,
  onModel,
  onEffort,
  onConnectModel,
}: {
  catalog: PiModelCatalogDto | null;
  model: ComposerModel | null;
  effort: string;
  onModel(value: ComposerModel): void;
  onEffort(value: string): void;
  onConnectModel: (() => void) | undefined;
}): ReactElement {
  return (
    <div className="home-model-controls" role="group" aria-label="Pi model and effort">
      <div className="home-model-control">
        {!catalog ? (
          <QuietWait label="Loading models…" />
        ) : (
          <PiModelPicker
            id="home-model-picker"
            models={catalog?.models ?? []}
            selected={model}
            disabled={!catalog?.models.length}
            onSelect={onModel}
            onManageModels={onConnectModel}
          />
        )}
      </div>
      <div className="home-model-control">
        {catalog && (
          <PiThinkingPicker
            id="home-thinking-picker"
            levels={model?.thinkingLevels ?? []}
            selected={effort}
            disabled={!model?.thinkingLevels.length}
            onSelect={onEffort}
          />
        )}
      </div>
    </div>
  );
}

function inPanel(): boolean {
  return new URLSearchParams(globalThis.location?.search ?? "").get("host") === "panel";
}

/** `www.steam.com/app/1` → `steam.com`; a page Aeon can't read is "the web". */
function pageHost(url: string | undefined): string {
  try {
    const host = new URL(url ?? "").hostname.replace(/^www\./, "");
    return host || "the web";
  } catch {
    return "the web";
  }
}

function needsModelConnect(props: HomeStartProps): boolean {
  return Boolean(props.modelCatalog && !props.modelCatalog.models.length && props.onConnectModel);
}
