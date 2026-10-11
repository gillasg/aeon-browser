import { AttachmentPreview } from "./attachment-preview.js";
import { type ReactElement } from "react";
import type {
  ComposerAttachment,
  ComposerControls,
  ComposerModel,
  PiContextUsage,
} from "./chat-composer.js";
import { PiModelPicker, PiThinkingPicker } from "./pi-model-picker.js";
import { PiContextUsageRing } from "./pi-context-usage.js";
import { AnnotationChips, useAnnotations } from "./transcript-annotations.js";

export interface ComposerPanelsProps {
  connected?: boolean;
  onTogglePiUi?(): void;
  piUiOpen?: boolean;
  mode: "followUp" | "steer";
  running: boolean;
  controls: ComposerControls | null;
  contextUsage?: PiContextUsage | null;
  attachments: readonly ComposerAttachment[];
  onMode(mode: "followUp" | "steer"): void;
  onModel(value: ComposerModel): void;
  onThinking(value: string): void;
  onRemoveAttachment(index: number): void;
}

export function ComposerPanels(props: ComposerPanelsProps): ReactElement {
  return (
    <>
      <div className="composer-meta">
        {props.connected === false || !props.controls?.effectiveModel ? (
          <span className="model-loading" role="status">
            {props.connected === false ? "Connecting…" : "Starting…"}
          </span>
        ) : (
          <>
            <ComposerModelControls props={props} />
            <PiContextUsageRing usage={props.contextUsage ?? null} />
            <PiToolsButton {...props} />
          </>
        )}
      </div>
    </>
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
