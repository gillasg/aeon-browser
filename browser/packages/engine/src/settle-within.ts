/** The promise's value, or "pending" when it has not settled within ms. */
export function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | "pending"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"pending">((resolve) => {
    timer = setTimeout(() => resolve("pending"), ms);
  });
  return Promise.race([promise.catch(() => "pending" as const), late]).finally(() =>
    clearTimeout(timer),
  );
}
