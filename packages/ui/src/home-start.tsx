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
import { PromptField } from "./prompt-field.js";
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
};

export function HomeStart({ props }: { props: HomeStartProps }): ReactElement {
  const panelPage = usePanelPage();
  const [query, setQuery] = useState("");
  // The ⌘K palette puts a site action in the ask box ("aeon.home.seed").
  useEffect(() => {
    const seed = (event: Event): void => {
      setQuery(String((event as CustomEvent<string>).detail ?? ""));
      requestAnimationFrame(() => document.getElementById("home-query")?.focus());
    };
    window.addEventListener("aeon.home.seed", seed);
    return () => window.removeEventListener("aeon.home.seed", seed);
  }, []);
  const files = useHomeAttachments(props.onReadAttachments);
  const selection = useHomeSelection(props.modelCatalog);
  const ask = (value: string): void => {
    if (selection.model)
      props.onAsk(value, selection.model, selection.thinkingLevel, files.attachments);
  };
  return (
    <section className="home-start" aria-label="Ask Aeon">
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
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (query.trim() && canSubmit) onSubmit(query.trim());
  };
  return (
    <form id="home-form" className="home-query-form" onSubmit={submit}>
      <HomeAttachmentPicker onFiles={onFiles} contextId={contextId} />
      <PromptField
        multiline
        id="home-query"
        value={query}
        placeholder="Ask Aeon to do anything"
        ariaLabel="Ask Aeon anything"
        onChange={onQuery}
        onFiles={onFiles}
        onEnter={() => {
          if (query.trim() && canSubmit) onSubmit(query.trim());
        }}
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
