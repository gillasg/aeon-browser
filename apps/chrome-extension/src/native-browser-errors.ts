export class BrowserActionError extends Error {
  constructor(
    code: string,
    readonly detail: string,
  ) {
    super(code);
  }
}
export function browserErrorDetail(error: unknown): string | undefined {
  return error instanceof BrowserActionError ? error.detail.slice(0, 2000) : undefined;
}
