// A short page, or a 429, is the site saying stop. Another request repeats it.

const PHRASES = /too many (?:attempts|requests)|try again later|rate limit|slow down|\b429\b/i;

export function rateLimited(text: string, status?: number): boolean {
  if (status === 429) return true;
  if (text.length > 800) return false;
  return PHRASES.test(text);
}

export function rateLimitWarning(text: string, status?: number): string | undefined {
  if (!rateLimited(text, status)) return undefined;
  return "[warn] RATE_LIMITED: another request repeats the limit; report it";
}
