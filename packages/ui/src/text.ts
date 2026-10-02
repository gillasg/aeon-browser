export function shortDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "recently"
    : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}
