import type { ManagementSnapshotDto } from "@pippin/protocol";
import type { ManagementActionName, ManagementSection } from "./management-types.js";

export interface ManagementSurfaceProps {
  section: ManagementSection;
  snapshot: ManagementSnapshotDto | null;
  selectedChatId: string;
  loading: boolean;
  error: string;
  connectionLabel: string;
  theme: "dark" | "midnight" | "light" | "system";
  sidebarDefaultOpen: boolean;
  onRefresh(): void;
  onSelectChat(chatId: string): void;
  onOpenChat(chatId: string): void;
  onAction(chatId: string, action: ManagementActionName, input: Record<string, unknown>): void;
  onTheme(theme: "dark" | "midnight" | "light" | "system"): void;
  onSidebarDefault(open: boolean): void;
}
