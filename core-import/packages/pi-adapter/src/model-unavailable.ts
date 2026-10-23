/** A model a person chose (or set as their default) is gone, and signing in again is the fix. */
export function modelUnavailable(provider: string, id: string): Error {
  return new Error(
    `${provider}/${id} isn't available. Sign in to ${provider} again from the model picker ("Add or manage models…").`,
  );
}
