import type { PrivacySettingsProps } from "./privacy-settings.js";
import type { ManagementSnapshotDto } from "@aeon/protocol";
import type { ManagementActionName, ManagementSection } from "./management-types.js";

export interface ManagementSurfaceProps {
  section: ManagementSection;
  /** Shown inside another page (Settings, Advanced): a small section heading, not the page's. */
  subsection?: boolean;
  snapshot: ManagementSnapshotDto | null;
  selectedChatId: string;
  loading: boolean;
  error: string;
  connectionLabel: string;
  theme: "dark" | "midnight" | "light" | "system";
  onRefresh(): void;
  onSelectChat(chatId: string): void;
  onOpenChat(chatId: string): void;
  onAction(chatId: string, action: ManagementActionName, input: Record<string, unknown>): void;
  onTheme(theme: "dark" | "midnight" | "light" | "system"): void;
  /** The shared blocked-sites list, loaded from the daemon. */
  blockedSites?: readonly string[];
  onBlockedSiteAdd?(site: string): void;
  onBlockedSiteRemove?(site: string): void;
  /** Outside agents may see the user's open tabs (opt-in, stored by the daemon). */
  outsideContext?: boolean;
  /** Settings → Privacy. */
  privacy?: PrivacySettingsProps | undefined;
  onOutsideContext?(enabled: boolean): void;
  /** Settings → Other agents: new chats load the user's own Pi extensions (off by default). */
  /** Goes home with this example in the ask box (an empty page's one action). */
  onSuggest?(example: string): void;
  /** Opens the site and starts Teach there (the recording pill). */
  onTeachSite?(host: string): void;
}
