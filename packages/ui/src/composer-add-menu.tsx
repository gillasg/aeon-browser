import type { ReactElement } from "react";
import { useComposerAddMenu, type ContextTab } from "./composer-add-state.js";

export function ComposerAddMenu(props: {
  onFiles(): void;
  contextId?: string | undefined;
}): ReactElement {
  const state = useComposerAddMenu(props.contextId ?? "draft");
  return (
    <div className="composer-add-wrap" ref={state.root}>
      <button
        className="attach-button"
        type="button"
        title="Add files or tabs"
        aria-label="Add files or tabs"
        aria-expanded={state.open}
        aria-haspopup="dialog"
        onClick={() => {
          state.setOpen(!state.open);
          state.setTabs(null);
          state.setError("");
        }}
      >
        <svg
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
      {state.open && (
        <AddMenuDialog
          tabs={state.tabs}
          error={state.error}
          loading={state.loading}
          onFiles={() => {
            state.setOpen(false);
            props.onFiles();
          }}
          onTabs={() => void state.listTabs()}
          onBack={() => {
            state.setTabs(null);
            state.setError("");
          }}
          onChoose={(id) => void state.choose(id)}
        />
      )}
    </div>
  );
}
interface AddMenuProps {
  tabs: ContextTab[] | null;
  error: string;
  loading: boolean;
  onFiles(): void;
  onTabs(): void;
  onBack(): void;
  onChoose(id: number): void;
}
function AddMenuDialog(props: AddMenuProps): ReactElement {
  return (
    <div className="composer-add-menu" role="dialog" aria-label="Add context">
      {props.tabs === null ? (
        <>
          <button type="button" onClick={props.onFiles}>
            <span aria-hidden="true">＋</span> Add files
          </button>
          <button type="button" disabled={props.loading} onClick={props.onTabs}>
            <span aria-hidden="true">▣</span> Add tabs
          </button>
        </>
      ) : (
        <TabPicker {...props} tabs={props.tabs} />
      )}
      {props.error && <p role="alert">{props.error}</p>}
    </div>
  );
}
function TabPicker(props: AddMenuProps & { tabs: ContextTab[] }): ReactElement {
  return (
    <>
      <button className="tab-picker-back" type="button" onClick={props.onBack}>
        <span aria-hidden="true">‹</span> Back
      </button>
      <div className="tab-picker-list">
        {props.tabs.map((tab) => (
          <button
            type="button"
            disabled={props.loading}
            key={tab.tabId}
            title={tab.url}
            onClick={() => props.onChoose(tab.tabId)}
          >
            <span className="tab-picker-icon">
              {tab.favIconUrl && /^https?:/.test(tab.favIconUrl) ? (
                <img src={tab.favIconUrl} alt="" referrerPolicy="no-referrer" />
              ) : (
                "◎"
              )}
            </span>
            <span className="tab-picker-title">{tab.title || tab.url}</span>
            {tab.current && <span className="tab-picker-current">· Current tab</span>}
          </button>
        ))}
        {!props.tabs.length && <p>No supported tabs open.</p>}
      </div>
    </>
  );
}
