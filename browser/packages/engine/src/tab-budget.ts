// The ninth agent tab is refused. Eight may stay open; the model closes one itself.
// Pool and job tabs are not part of that eight. A slot is reserved before any await.

export const TAB_BUDGET = 8;

export interface BudgetTab {
  id: number;
  url: string;
  touched?: number;
  popup?: boolean;
  pool?: boolean;
}

const held = new Map<string, number>();

export function budgetTabs(open: BudgetTab[]): { id: number; url: string; touched: number }[] {
  return open
    .filter((tab) => tab.popup !== true && tab.pool !== true)
    .sort((left, right) => (left.touched ?? 0) - (right.touched ?? 0) || left.id - right.id)
    .map((tab) => ({ id: tab.id, url: tab.url, touched: tab.touched ?? 0 }));
}

export function tabBudgetError(open: BudgetTab[], extra = 0): string | undefined {
  const counted = budgetTabs(open);
  const count = counted.length + extra;
  if (count < TAB_BUDGET) return undefined;
  const listed = counted.map((tab) => `${tab.id} ${tab.url}`).join("; ");
  const close = listed ? ` Close the oldest first: ${listed}.` : "";
  return `TAB_BUDGET: ${count} agent tabs are open.${close} Close one with browser.closeTab(id) or page.close()`;
}

/** Reserve one budget slot. Call it synchronously, before the first await of an open. */
export function takeTabSlot(
  chatId: string | undefined,
  open: BudgetTab[],
  exempt = false,
): { release: () => void; error?: string } {
  if (!chatId || exempt) return { release() {} };
  const extra = held.get(chatId) ?? 0;
  const error = tabBudgetError(open, extra);
  if (error) return { release() {}, error };
  held.set(chatId, extra + 1);
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      const next = (held.get(chatId) ?? 1) - 1;
      if (next <= 0) held.delete(chatId);
      else held.set(chatId, next);
    },
  };
}
