// Feed schedules: "every day at HH:MM" in a time zone (DST-aware) or "every N hours".

export type FeedSchedule = { kind: 'daily'; time: string; timezone: string } | { kind: 'hourly'; everyHours: number };

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
}

/** Offset (ms) of the zone from UTC at a given instant. */
function offsetAt(instant: number, timeZone: string): number {
  const p = zonedParts(new Date(instant), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return asUtc - Math.floor(instant / 60_000) * 60_000;
}

/** UTC instant of a wall-clock time in a zone. Non-existent times (DST gap) resolve to the next valid instant. */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let ts = guess - offsetAt(guess, timeZone);
  const corrected = guess - offsetAt(ts, timeZone);
  if (corrected !== ts) ts = Math.max(ts, corrected);
  return new Date(ts);
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Next run strictly after `now`. */
export function nextRun(schedule: FeedSchedule, now: Date = new Date()): Date {
  if (schedule.kind === 'hourly') return new Date(now.getTime() + schedule.everyHours * 3600_000);
  const [hh, mm] = schedule.time.split(':').map(Number);
  const today = zonedParts(now, schedule.timezone);
  let candidate = zonedTimeToUtc(today.year, today.month, today.day, hh, mm, schedule.timezone);
  if (candidate.getTime() <= now.getTime()) {
    const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
    candidate = zonedTimeToUtc(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), hh, mm, schedule.timezone);
  }
  return candidate;
}

export function describeSchedule(s: FeedSchedule): string {
  return s.kind === 'daily' ? `ogni giorno alle ${s.time} (${s.timezone})` : `ogni ${s.everyHours} ${s.everyHours === 1 ? 'ora' : 'ore'}`;
}
