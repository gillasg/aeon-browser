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
    /** True when the login is saved by Aeon and can be signed out here. */
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
}
