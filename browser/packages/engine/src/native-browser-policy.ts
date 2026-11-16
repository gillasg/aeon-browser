// Shared with mapped-site calls. The decisions live in one place so a redirect hop and an agent
// navigation refuse the same addresses.
export {
  literalLoopback,
  preflightHost,
  privateAddress,
  privateTarget,
  resolvedTarget,
} from "@browserkit/protocol";
