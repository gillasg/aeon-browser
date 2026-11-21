// What a hand-off is for. A sign-in or a bot check is the site in the way; a cliff edge is the
// agent stopping on purpose at something that commits the user to a real-world outcome (pay, send,
// submit, delete) and waiting for their go-ahead. The cursor and the chat show the two
// differently, so the agent says which one it is. Both are optional: a bare bu.handoff(message)
// is exactly what it always was.

export const HANDOFF_KINDS = ["auth", "captcha", "cliff-edge"] as const;
export type HandoffKind = (typeof HANDOFF_KINDS)[number];

export interface HandoffMeta {
  kind?: HandoffKind;
  /** The commitment in words, for the confirm button: "Pay $42.10", "Send", "Delete 3 files". */
  actionLabel?: string;
}

const MAX_ACTION_LABEL = 40;

/**
 * The kind and action label from a hand-off request, cleaned. An unknown kind is refused so a
 * typo does not quietly turn a go-ahead into an ordinary hand-off.
 */
export function handoffMeta(input: { kind?: unknown; actionLabel?: unknown }): HandoffMeta {
  const meta: HandoffMeta = {};
  if (input.kind !== undefined && input.kind !== null) {
    if (!HANDOFF_KINDS.includes(input.kind as HandoffKind))
      throw new Error(
        `INVALID_INPUT: bu.handoff kind must be one of ${HANDOFF_KINDS.join(", ")}, not ${JSON.stringify(input.kind)}`,
      );
    meta.kind = input.kind as HandoffKind;
  }
  const label = typeof input.actionLabel === "string" ? input.actionLabel.trim() : "";
  if (label) meta.actionLabel = label.slice(0, MAX_ACTION_LABEL);
  return meta;
}
