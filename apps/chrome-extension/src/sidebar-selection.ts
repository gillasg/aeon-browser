/** The chat a window's side panel shows (session storage), shared by the panel and the orb. */
export function sidePanelSelectionKey(windowId: number): string {
  return `aeon-selected-chat-${windowId}`;
}
