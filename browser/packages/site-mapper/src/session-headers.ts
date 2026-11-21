// Sign-in and anti-forgery headers a modern single-page app adds to its own API calls. Their
// values belong to the user's live session: they are read from the open tab, its cookies or the
// headers the site itself just sent, at call time. A compiled site model never stores them.

/** Values that are secrets of the session: never kept as a constant, example or sample. */
export const SESSION_SECRET_HEADER =
  /^(authorization|x-csrf-token|x-xsrf-token|csrf-token|x-xsrftoken|x-csrftoken|x-api-key|x-auth-token|x-access-token|x-client-transaction-id)$/i;

/**
 * Headers worth refreshing from the live tab on every call. The secret ones above plus a few
 * plain flags some sites refuse requests without (`x-requested-with`, `x-twitter-active-user`).
 */
export const SESSION_LIVE_HEADER =
  /^(authorization|x-csrf-token|x-xsrf-token|csrf-token|x-xsrftoken|x-csrftoken|x-api-key|x-auth-token|x-access-token|x-client-transaction-id|x-requested-with|x-twitter-active-user|x-twitter-auth-type|x-twitter-client-language)$/i;

/** Cookie names a site's JavaScript copies into a header, and the header it goes to. */
export const COOKIE_XSRF_HEADERS: readonly { cookie: string; header: string }[] = [
  { cookie: "XSRF-TOKEN", header: "x-xsrf-token" },
  { cookie: "csrftoken", header: "x-csrftoken" },
  { cookie: "csrf_token", header: "x-csrf-token" },
  { cookie: "ct0", header: "x-csrf-token" },
];

export function isSessionSecretHeader(name: string): boolean {
  return SESSION_SECRET_HEADER.test(name);
}

/** Placeholder written where a session value was, so a saved sample shows the header was sent. */
export const SESSION_VALUE = "[session]";

/** A copy of recorded headers with every session secret replaced by the placeholder. */
export function withoutSessionValues(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      isSessionSecretHeader(name) ? SESSION_VALUE : value,
    ]),
  );
}

/**
 * The anti-forgery headers the cookies imply, for headers not already set. `cookie` reads one
 * cookie's value from the live jar.
 */
export function cookieXsrfHeaders(
  cookie: (name: string) => string | undefined,
  present: Record<string, string> = {},
): Record<string, string> {
  const have = new Set(Object.keys(present).map((name) => name.toLowerCase()));
  const out: Record<string, string> = {};
  for (const { cookie: name, header } of COOKIE_XSRF_HEADERS) {
    if (have.has(header) || out[header]) continue;
    const value = cookie(name);
    if (value) out[header] = value;
  }
  return out;
}
