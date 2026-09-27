/** The ledger and dashboard intentionally share this zone, never browser-local time. */
export const DEFAULT_TIME_ZONE = "Asia/Jakarta";

function configured(): string {
  const candidate = Bun.env.NEXT_PUBLIC_TIMEZONE?.trim() || Bun.env.TIMEZONE?.trim() || DEFAULT_TIME_ZONE;
  try { new Intl.DateTimeFormat("en-GB", { timeZone: candidate }).format(); return candidate; } catch { return DEFAULT_TIME_ZONE; }
}
export function appTimeZone(): string { return configured(); }
function parts(value: Date | number, zone = configured()) {
  const entries = new Intl.DateTimeFormat("en-US", { timeZone: zone, calendar: "gregory", numberingSystem: "latn", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(value);
  const valueFor = (name: string) => Number(entries.find((entry) => entry.type === name)?.value);
  return { year: valueFor("year"), month: valueFor("month"), day: valueFor("day"), hour: valueFor("hour"), minute: valueFor("minute"), second: valueFor("second") };
}
function offset(date: Date, zone = configured()): number { const p = parts(date, zone); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - date.getTime(); }
function zoned(p: { year: number; month: number; day: number; hour: number; minute: number; second?: number }): Date {
  const guess = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second ?? 0);
  let result = new Date(guess - offset(new Date(guess)));
  result = new Date(guess - offset(result));
  return result;
}
export function startOfAppHour(value: Date | number): Date { const p = parts(value); return zoned({ ...p, minute: 0, second: 0 }); }
export function startOfAppDay(value: Date | number): Date { const p = parts(value); return zoned({ ...p, hour: 0, minute: 0, second: 0 }); }
export function startOfAppMonth(value: Date | number): Date { const p = parts(value); return zoned({ ...p, day: 1, hour: 0, minute: 0, second: 0 }); }
export function startOfAppYear(value: Date | number): Date { const p = parts(value); return zoned({ ...p, month: 1, day: 1, hour: 0, minute: 0, second: 0 }); }
/** Parses a YYYY-MM-DD dashboard date at midnight in the configured ledger zone. */
export function appDateStart(value: string): Date { const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value); if (!match) return new Date(NaN); return zoned({ year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), hour: 0, minute: 0, second: 0 }); }
export function appDateString(value: Date | number): string { const p = parts(value); return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`; }
export function addAppDays(value: Date | number, days: number): Date { const p = parts(value); const next = new Date(Date.UTC(p.year, p.month - 1, p.day + days, p.hour, p.minute, p.second)); return zoned({ year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate(), hour: next.getUTCHours(), minute: next.getUTCMinutes(), second: next.getUTCSeconds() }); }
export function mondayInAppTimeZone(value: Date | number = new Date()): Date { const day = startOfAppDay(value); const weekday = new Date(Date.UTC(parts(day).year, parts(day).month - 1, parts(day).day)).getUTCDay(); return addAppDays(day, -(weekday === 0 ? 6 : weekday - 1)); }
export function formatAppBucket(value: number, granularity: "hourly" | "daily" | "weekly" | "monthly"): string { return new Intl.DateTimeFormat("en-GB", { timeZone: configured(), ...(granularity === "hourly" ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" } : granularity === "monthly" ? { month: "short", year: "numeric" } : { month: "short", day: "numeric" }) }).format(value); }
