// The host answers validateUpload with the resolved paths; anything else (a host with no
// workspace answers {error}) is named, never handed on as the step's files.
export function uploadPaths(answer: unknown): string[] {
  if (Array.isArray(answer) && answer.every((item) => typeof item === "string")) return answer;
  const error = (answer as { error?: unknown } | null)?.error;
  throw new Error(
    `UNSUPPORTED: this host cannot check upload files${typeof error === "string" ? ` (${error})` : ""}`,
  );
}
