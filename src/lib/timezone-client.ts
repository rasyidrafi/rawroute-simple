/** Browser counterpart to timezone.ts. datetime-local values are always shown
 * and parsed in the ledger zone, never in the browser's current zone. */
function parts(value: number, timeZone: string) {
  const fields = new Intl.DateTimeFormat("en-US", { timeZone, calendar: "gregory", numberingSystem: "latn", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(value);
  const get = (name: string) => Number(fields.find((field) => field.type === name)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}
function offset(value: number, timeZone: string): number { const wholeSecond = value - ((value % 1_000 + 1_000) % 1_000); const p = parts(wholeSecond, timeZone); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - wholeSecond; }
export function formatLedgerDateTimeLocal(value: number, timeZone: string): string { const p = parts(value, timeZone); return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}T${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}:${String(p.second).padStart(2, "0")}.${String(((value % 1_000) + 1_000) % 1_000).padStart(3, "0")}`; }
/** An edited repeated wall time has no safe implicit instant. Callers may pass
 * the original instant only for an unchanged field, preserving its DST fold. */
function localCandidates(value: string, timeZone: string): number[] { const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value); if (!match) return []; const millisecond = Number((match[7] ?? "0").padEnd(3, "0")); const target = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), hour: Number(match[4]), minute: Number(match[5]), second: Number(match[6] ?? "0") }; const wall = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute, target.second, millisecond); const offsets = new Set([offset(wall, timeZone), offset(wall - 86_400_000, timeZone), offset(wall + 86_400_000, timeZone)]); return [...offsets].map((zoneOffset) => wall - zoneOffset).filter((candidate) => { const p = parts(candidate, timeZone); return p.year === target.year && p.month === target.month && p.day === target.day && p.hour === target.hour && p.minute === target.minute && p.second === target.second; }).sort((left, right) => left - right); }
export function isAmbiguousLedgerDateTimeLocal(value: string, timeZone: string): boolean { return localCandidates(value, timeZone).length > 1; }
export function parseLedgerDateTimeLocal(value: string, timeZone: string, originalInstant?: number): number | undefined { const candidates = localCandidates(value, timeZone); if (candidates.length === 1) return candidates[0]; if (originalInstant !== undefined && candidates.includes(originalInstant)) return originalInstant; // The standalone parser uses the later (standard-time) fold. UI editing uses
  // isAmbiguousLedgerDateTimeLocal and rejects an edited repeated wall time.
  return candidates.at(-1); }
