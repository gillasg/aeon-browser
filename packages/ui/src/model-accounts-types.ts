// What the Models page shows. The extension reads it from the daemon's sign-in service, which
// saves logins where Pi keeps them, so chats, the Pi CLI and other Pi apps all see them.

export interface ModelProviderMethod {
  type: "oauth" | "api_key";
  /** "Sign in with ChatGPT", "Anthropic API key"… */
  label: string;
  subscription: boolean;
}

export interface ModelProvider {
  id: string;
  name: string;
  methods: readonly ModelProviderMethod[];
  connected: boolean;
  connection?: {
    type: "oauth" | "api_key";
    /** Where an outside login comes from: "ANTHROPIC_API_KEY", "~/.aws/credentials"… */
    source?: string;
    /** True when the login is saved by Graft and can be signed out here. */
    stored: boolean;
  };
}

export interface ModelAccountsState {
  providers: readonly ModelProvider[];
  models: readonly { provider: string; id: string; name: string }[];
  defaultModel?: { provider: string; model: string };
}

/** One sign-in in progress, as the page renders it. */
export interface ModelSignInFlow {
  provider: ModelProvider;
  method: "oauth" | "api_key";
  /** Messages from the provider, oldest first. */
  notes: readonly { message: string; links?: readonly { url: string; label?: string }[] }[];
  authUrl?: { url: string; instructions?: string };
  deviceCode?: { userCode: string; verificationUri: string };
  progress?: string;
  prompt?: {
    promptId: string;
    kind: string;
    message: string;
    placeholder?: string;
    options?: readonly { id: string; label: string; description?: string }[];
  };
  result?: { kind: "done" } | { kind: "error"; message: string } | { kind: "cancelled" };
}

export interface ModelAccountsProps {
  /** Null while loading. */
  state: ModelAccountsState | null;
  flow: ModelSignInFlow | null;
  error: string;
  /** The page is on screen: load the providers and follow changes until `onHide`. */
  onShow(): void;
  onHide(): void;
  onStart(provider: ModelProvider, method: "oauth" | "api_key"): void;
  onAnswer(promptId: string, value: string): void;
  onCancel(): void;
  onCloseFlow(): void;
  onSignOut(provider: ModelProvider): void;
  onDefaultModel(choice: { provider: string; model: string } | undefined): void;
  onOpenUrl(url: string): void;
  /**
   * Leaves the Models page for work: back to the chat that asked for a model, or a new chat.
   * Shown after a sign-in and whenever a model is ready.
   */
  onStartChat?: (() => void) | undefined;
  /** "Return to chat" when another Graft view sent the user here, else "Start chatting". */
  startChatLabel?: string | undefined;
}

/** How a provider is connected, as a short badge: a subscription, a saved key or the environment. */
export function connectionBadge(provider: ModelProvider): string | undefined {
  const connection = provider.connection;
  if (!connection) return undefined;
  if (!connection.stored) return "Environment";
  if (connection.type === "api_key") return "API key";
  return provider.methods.some((method) => method.type === "oauth" && method.subscription)
    ? "Subscription"
    : "Account";
}

/** The providers most people start with, in the order the Models page lists them. */
export const POPULAR_PROVIDERS: readonly string[] = [
  "anthropic",
  "openai",
  "openai-codex",
  "github-copilot",
  "google",
  "xai",
  "openrouter",
];

/** The default model's display name, or its id when the catalog does not list it. */
export function defaultModelName(state: ModelAccountsState | null): string | undefined {
  const choice = state?.defaultModel;
  if (!choice) return undefined;
  return (
    state.models.find((model) => model.provider === choice.provider && model.id === choice.model)
      ?.name ?? choice.model
  );
}
