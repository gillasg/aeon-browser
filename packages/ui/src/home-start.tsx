import { PageContextTray } from "./page-context-tray.js";
import { usePanelPage } from "./panel-page-chip.js";
import { ProjectChip } from "./project-chip.js";
import {
  useHomeAttachments,
  HomeAttachmentPicker,
  HomeAttachmentList,
} from "./home-attachments.js";
import { useState, type FormEvent, type ReactElement } from "react";
import type { ChatCatalogItemDto, PiModelCatalogDto } from "@pippin/protocol";
import type { ComposerModel } from "./chat-composer.js";
import { PiModelPicker, PiThinkingPicker, modelKey } from "./pi-model-picker.js";
import { HomeRecentCards } from "./home-recent-cards.js";
import { PromptField } from "./prompt-field.js";
import type { NewTabHomeProps } from "./home-surface.js";

type HomeStartProps = Pick<
  NewTabHomeProps,
  | "modelCatalog"
  | "onAsk"
  | "homeRoutines"
  | "openChatIds"
  | "onOpenChat"
  | "onCatalog"
  | "onReadAttachments"
> & {
  onManageRoutines(): void;
  projectName?: string | null;
  projectId?: string | null;
  browserContext?: import("@pippin/protocol").PiBrowserContextRecord | null;
  onRemoveContext?(): void;
  chatId?: string;
};

export function HomeStart({
  props,
  active,
}: {
  props: HomeStartProps;
  active: readonly ChatCatalogItemDto[];
}): ReactElement {
  const panelPage = usePanelPage();
  const page = props.browserContext ?? panelPage.record;
  const [query, setQuery] = useState("");
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
        primary={page}
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
        canSubmit={Boolean(selection.model && selection.thinkingLevel && !files.loading)}
        onSubmit={ask}
        onFiles={(items) => void files.add(items)}
      />
      <HomeModelControls
        catalog={props.modelCatalog}
        model={selection.model}
        effort={selection.thinkingLevel}
        onModel={selection.setModel}
        onEffort={selection.setEffort}
      />
      <HomeRecentCards
        chats={active}
        routines={props.homeRoutines}
        openChatIds={props.openChatIds}
        onCatalog={props.onCatalog}
        onOpen={props.onOpenChat}
        onRoutines={props.onManageRoutines}
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
        placeholder=""
        ariaLabel="Ask Aeon anything"
        onChange={onQuery}
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
  catalog,
  model,
  effort,
  onModel,
  onEffort,
}: {
  catalog: PiModelCatalogDto | null;
  model: ComposerModel | null;
  effort: string;
  onModel(value: ComposerModel): void;
  onEffort(value: string): void;
}): ReactElement {
  return (
    <div className="home-model-controls" role="group" aria-label="Pi model and effort">
      <div className="home-model-control">
        {!catalog ? (
          <span className="model-loading" role="status">
            Loading models…
          </span>
        ) : (
          <PiModelPicker
            id="home-model-picker"
            models={catalog?.models ?? []}
            selected={model}
            disabled={!catalog?.models.length}
            onSelect={onModel}
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
