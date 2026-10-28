import { AttachmentPreview } from "./attachment-preview.js";
import { type ReactElement } from "react";
import type {
  ComposerAttachment,
  ComposerControls,
  ComposerModel,
  PiContextUsage,
} from "./chat-composer.js";
import { PiModelPicker, PiThinkingPicker } from "./pi-model-picker.js";
import { ConnectModelCard, type ModelLoginState } from "./connect-model-card.js";
import { PiContextUsageRing } from "./pi-context-usage.js";
import { QuietWait } from "./pending-work.js";
import { AnnotationChips, useAnnotations } from "./transcript-annotations.js";

export interface ComposerPanelsProps {
  connected?: boolean;
  onTogglePiUi?(): void;
  piUiOpen?: boolean;
  mode: "followUp" | "steer";
  running: boolean;
  controls: ComposerControls | null;
  /** Why the Chat's Pi session could not start; kept so it is never only a passing toast. */
  controlsError?: string | undefined;
  contextUsage?: PiContextUsage | null;
  attachments: readonly ComposerAttachment[];
  onMode(mode: "followUp" | "steer"): void;
  onModel(value: ComposerModel): void;
  onThinking(value: string): void;
  onRemoveAttachment(index: number): void;
  modelLogin?: ModelLoginState;
  /** Opens the model sign-in page (every provider Pi supports). */
  onManageModels?(): void;
}

export function ComposerPanels(props: ComposerPanelsProps): ReactElement {
  return (
    <div className="composer-meta">
      <PanelsContent props={props} />
    </div>
  );
}

function PanelsContent({ props }: { props: ComposerPanelsProps }): ReactElement {
  const emptyCard = emptyModelsCard(props);
  if (emptyCard) return emptyCard;
  if (props.connected === false) return <ModelLoading connecting />;
  if (!props.controls) {
    if (props.controlsError) return <StartError props={props} />;
    return <ModelLoading connecting={false} />;
  }
  if (!props.controls.effectiveModel) return <ModelLoading connecting={false} />;
  return <WorkingPanels props={props} />;
}

function emptyModelsCard(props: ComposerPanelsProps): ReactElement | null {
  if (!props.controls || props.controls.availableModels.length || !props.onManageModels)
    return null;
  return (
    <ConnectModelCard
      state={props.modelLogin ?? { waiting: false }}
      onConnect={props.onManageModels}
    />
  );
}

function ModelLoading({ connecting }: { connecting: boolean }): ReactElement {
  return <QuietWait label={connecting ? "Connecting…" : "Starting…"} />;
}

function WorkingPanels({ props }: { props: ComposerPanelsProps }): ReactElement {
  return (
    <>
      <ComposerModelControls props={props} />
      {props.modelLogin?.error && <SignInError message={props.modelLogin.error} />}
      <PiContextUsageRing usage={props.contextUsage ?? null} />
      <PiToolsButton {...props} />
    </>
  );
}

/** A Chat whose Pi session could not start: say why, and reopen the same sign-in page. */
function StartError({ props }: { props: ComposerPanelsProps }): ReactElement {
  return (
    <div className="connect-model" role="region" aria-label="This Chat cannot start">
      <div className="connect-model-body">
        <strong>This Chat can&apos;t start</strong>
        <p>{props.controlsError}</p>
        {props.modelLogin?.error && (
          <p className="connect-model-error" role="alert">
            {props.modelLogin.error}
          </p>
        )}
      </div>
      {props.onManageModels && (
        <button type="button" className="connect-model-button" onClick={props.onManageModels}>
          Sign in again
        </button>
      )}
    </div>
  );
}

/** A failed "Add or manage models…" next to the pickers, so it is never silent here either. */
function SignInError({ message }: { message: string }): ReactElement {
  return (
    <div className="connect-model" role="alert">
      <div className="connect-model-body">
        <p className="connect-model-error">{message}</p>
      </div>
    </div>
  );
}

export function AttachmentList({
  attachments,
  onRemoveAttachment,
}: Pick<ComposerPanelsProps, "attachments" | "onRemoveAttachment">): ReactElement | null {
  const annotations = useAnnotations();
  if (!attachments.length && !annotations?.records.length) return null;
  return (
    <div className="attachment-list" aria-live="polite">
      <AnnotationChips />
      {attachments.map((file, index) => (
        <AttachmentPreview
          key={file.name + ":" + index}
          file={file}
          onRemove={() => onRemoveAttachment(index)}
        />
      ))}
    </div>
  );
}

function ComposerModelControls({ props }: { props: ComposerPanelsProps }): ReactElement {
  return (
    <>
      <div className="pi-control" aria-label="Pi model">
        <PiModelPicker
          id="model-picker"
          models={props.controls?.availableModels ?? []}
          selected={props.controls?.effectiveModel ?? null}
          disabled={!props.controls?.availableModels.length}
          onSelect={props.onModel}
          onManageModels={props.onManageModels}
        />
      </div>
      <div className="pi-control" aria-label="Thinking effort">
        <PiThinkingPicker
          id="thinking-picker"
          levels={props.controls?.availableThinkingLevels ?? []}
          selected={props.controls?.thinkingLevel ?? ""}
          disabled={!props.controls?.availableThinkingLevels.length}
          onSelect={props.onThinking}
        />
      </div>
    </>
  );
}

function PiToolsButton(
  props: Pick<ComposerPanelsProps, "onTogglePiUi" | "piUiOpen">,
): ReactElement {
  return (
    <>
      {props.onTogglePiUi && (
        <button
          id="pi-tools-toggle"
          className="pi-tools-icon"
          type="button"
          aria-label="Pi tools"
          title="Pi tools"
          aria-pressed={props.piUiOpen}
          onClick={props.onTogglePiUi}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
          >
            <path d="m4 6 4 4-4 4m7 0h5" />
          </svg>
        </button>
      )}
    </>
  );
}
