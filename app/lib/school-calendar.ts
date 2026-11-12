import sourceCalendar from "./casa-school-calendar.json";

export type SchoolClosure = { start: string; end: string; label: string };
export type SchoolCalendar = {
  campus: string;
  academicYear: string;
  startDate: string;
  endDate: string;
  closedWeekdays: number[];
  closures: SchoolClosure[];
  source: { url: string; verifiedAt: string };
};

// This checked-in snapshot is shared by the date picker and mutation routes.
// It contains school closure dates only, never private Toddle credentials.
export const schoolCalendar: SchoolCalendar = sourceCalendar;

const unavailable = "The school calendar is unavailable. Ask an administrator to update it.";
const outsideCalendar = "This date is outside the verified school calendar. Ask an administrator to update it.";
const dayMilliseconds = 24 * 60 * 60 * 1000;

function dateTimestamp(value: string): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value ? timestamp : null;
}

function calendarIsUsable(calendar: SchoolCalendar): boolean {
  if (!calendar || dateTimestamp(calendar.startDate) === null || dateTimestamp(calendar.endDate) === null || calendar.startDate > calendar.endDate) return false;
  if (!Array.isArray(calendar.closedWeekdays) || !calendar.closedWeekdays.every(day => Number.isInteger(day) && day >= 0 && day <= 6)) return false;
  return Array.isArray(calendar.closures) && calendar.closures.every(closure =>
    !!closure && dateTimestamp(closure.start) !== null && dateTimestamp(closure.end) !== null && closure.start <= closure.end && typeof closure.label === "string" && !!closure.label.trim(),
  );
}

export function schoolDayClosure(date: string, calendar: SchoolCalendar = schoolCalendar): string | null {
  const timestamp = dateTimestamp(date);
  if (timestamp === null) return "Choose a valid calendar date.";
  if (!calendarIsUsable(calendar)) return unavailable;
  if (date < calendar.startDate || date > calendar.endDate) return outsideCalendar;
  const closure = calendar.closures.find(item => date >= item.start && date <= item.end);
  if (closure) return `School is closed: ${closure.label}.`;
  if (calendar.closedWeekdays.includes(new Date(timestamp).getUTCDay())) return "School is closed on weekends.";
  return null;
}

export function isSchoolDay(date: string, calendar: SchoolCalendar = schoolCalendar): boolean {
  return schoolDayClosure(date, calendar) === null;
}

export function reflectionDayClosure(date: string, calendar: SchoolCalendar = schoolCalendar): string | null {
  const closure = schoolDayClosure(date, calendar);
  if (closure) return closure;
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return weekday >= 1 && weekday <= 4 ? null : "Lunch reflections run Monday through Thursday.";
}

export function nextReflectionDay(date: string, includeCurrent = false, calendar: SchoolCalendar = schoolCalendar): string | null {
  return findCalendarDay(date, 1, includeCurrent, calendar, value => reflectionDayClosure(value, calendar) === null);
}

export function nextSchoolDay(date: string, direction: 1 | -1 = 1, includeCurrent = false, calendar: SchoolCalendar = schoolCalendar): string | null {
  return findCalendarDay(date, direction, includeCurrent, calendar, value => isSchoolDay(value, calendar));
}

// Search in one direction and stop at the verified boundary. The cap is a
// defensive bound for malformed calendar configuration, not a guessed holiday.
function findCalendarDay(date: string, direction: 1 | -1, includeCurrent: boolean, calendar: SchoolCalendar, isAvailable: (value: string) => boolean): string | null {
  const timestamp = dateTimestamp(date);
  if (timestamp === null || !calendarIsUsable(calendar) || (direction !== 1 && direction !== -1)) return null;
  let candidate = timestamp + (includeCurrent ? 0 : direction * dayMilliseconds);
  const start = dateTimestamp(calendar.startDate)!;
  const end = dateTimestamp(calendar.endDate)!;
  if (direction === 1 && candidate < start) candidate = start;
  if (direction === -1 && candidate > end) candidate = end;
  for (let checked = 0; checked < 3660 && candidate >= start && candidate <= end; checked++, candidate += direction * dayMilliseconds) {
    const value = new Date(candidate).toISOString().slice(0, 10);
    if (isAvailable(value)) return value;
  }
  return null;
}
