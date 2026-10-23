export class ValidationError extends Error {}

export type ReflectionSlot = "morning" | "lunch";
export type AttendanceStatus = "pending" | "present" | "absent";
export type StaffRole = "admin" | "teacher" | "moderator";
export type StaffStatus = "active" | "disabled";
export type RosterStudent = { name: string; grade: string; className: string; rosterKey: string; toddleId: string | null };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("Please send a JSON object.");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maxLength: number, optional = false): string {
  if (optional && (value === undefined || value === null)) return "";
  if (typeof value !== "string") throw new ValidationError(`${label} must be text.`);
  const cleaned = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!cleaned && !optional) throw new ValidationError(`${label} is required.`);
  if (cleaned.length > maxLength) throw new ValidationError(`${label} must be ${maxLength} characters or fewer.`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(cleaned)) {
    throw new ValidationError(`${label} contains an unsupported character.`);
  }
  return cleaned;
}

export function validDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ValidationError("Choose a date in YYYY-MM-DD format.");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ValidationError("Choose a valid calendar date.");
  }
  return value;
}

export function validId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) {
    throw new ValidationError("The selected record is invalid.");
  }
  return value;
}

export function assignmentInput(value: unknown, fallbackName: string) {
  const body = record(value);
  if (!Array.isArray(body.studentIds) || !body.studentIds.length || body.studentIds.length > 2000) {
    throw new ValidationError("Select between 1 and 2,000 students.");
  }
  const studentIds = [...new Set(body.studentIds.map(validId))];
  if (!Array.isArray(body.slots) || !body.slots.length || body.slots.length > 2 ||
      !body.slots.every((slot) => slot === "morning" || slot === "lunch")) {
    throw new ValidationError("Choose morning break, lunch break, or both.");
  }
  const slots = [...new Set(body.slots)] as ReflectionSlot[];
  return {
    studentIds,
    slots,
    date: validDate(body.date),
    reason: text(body.reason, "Reason", 1000, true),
    // Attribution comes from active server membership. Legacy clients may still
    // send assignedBy, but it must never override the authenticated staff name.
    assignedBy: fallbackName.slice(0, 120),
  };
}

export function attendanceInput(value: unknown): AttendanceStatus {
  const body = record(value);
  if (body.status !== "pending" && body.status !== "present" && body.status !== "absent") {
    throw new ValidationError("Attendance must be pending, present, or absent.");
  }
  return body.status;
}

export function rescheduleInput(value: unknown): { date: string; slot: ReflectionSlot } {
  const body = record(value);
  if (body.slot !== "morning" && body.slot !== "lunch") {
    throw new ValidationError("Choose one replacement session: morning break or lunch break.");
  }
  return { date: validDate(body.date), slot: body.slot };
}

export function rosterInput(value: unknown): { students: RosterStudent[]; source: string } {
  const body = record(value);
  if (!Array.isArray(body.students) || !body.students.length || body.students.length > 2000) {
    throw new ValidationError("Import between 1 and 2,000 students at a time.");
  }
  const unique = new Map<string, RosterStudent>();
  body.students.forEach((value, index) => {
    const row = record(value);
    const name = text(row.name, `Student name on row ${index + 1}`, 120);
    const grade = text(row.grade, `Grade on row ${index + 1}`, 40);
    const className = text(row.className, `Class on row ${index + 1}`, 60);
    const toddleId = row.toddleId === undefined || row.toddleId === null || row.toddleId === "" ? null : validId(row.toddleId);
    const rosterKey = makeRosterKey(name, grade, className, toddleId);
    if (toddleId && unique.has(rosterKey)) {
      const previous = unique.get(rosterKey)!;
      if (previous.name !== name || previous.grade !== grade || previous.className !== className) {
        throw new ValidationError(`The same Toddle ID appears with conflicting details on row ${index + 1}.`);
      }
    }
    unique.set(rosterKey, { name, grade, className, rosterKey, toddleId });
  });
  return { students: [...unique.values()], source: text(body.source, "Roster source", 160) };
}

export function makeRosterKey(name: string, grade: string, className: string, toddleId?: string | null): string {
  if (toddleId) return `toddle:${toddleId}`;
  return JSON.stringify([name, grade, className].map((part) => part.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US")));
}

export function studentPatchInput(value: unknown): { name?: string; grade?: string; className?: string; active?: boolean } {
  const body = record(value);
  const result: { name?: string; grade?: string; className?: string; active?: boolean } = {};
  if ("name" in body) result.name = text(body.name, "Student name", 120);
  if ("grade" in body) result.grade = text(body.grade, "Grade", 40);
  if ("className" in body) result.className = text(body.className, "Class", 60);
  if ("active" in body) {
    if (typeof body.active !== "boolean") throw new ValidationError("Student active status must be true or false.");
    result.active = body.active;
  }
  if (!Object.keys(result).length) throw new ValidationError("Provide a student name, grade, class, or active status to change.");
  return result;
}

export function normalizedEmail(value: unknown): string {
  const email = text(value, "Email", 254).toLocaleLowerCase("en-US");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidationError("Enter a valid staff email address.");
  return email;
}

function staffRole(value: unknown): StaffRole {
  if (value !== "admin" && value !== "teacher" && value !== "moderator") throw new ValidationError("Staff role must be admin, teacher, or moderator.");
  return value;
}

export function userCreateInput(value: unknown): { name: string; email: string; role: StaffRole } {
  const body = record(value);
  return { name: text(body.name, "Staff name", 120), email: normalizedEmail(body.email), role: staffRole(body.role) };
}

export function userPatchInput(value: unknown): { name?: string; role?: StaffRole; status?: StaffStatus } {
  const body = record(value);
  const result: { name?: string; role?: StaffRole; status?: StaffStatus } = {};
  if ("name" in body) result.name = text(body.name, "Staff name", 120);
  if ("role" in body) result.role = staffRole(body.role);
  if ("status" in body) {
    if (body.status !== "active" && body.status !== "disabled") throw new ValidationError("Staff status must be active or disabled.");
    result.status = body.status;
  }
  if (!Object.keys(result).length) throw new ValidationError("Provide a staff name, role, or status to change.");
  return result;
}

export function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}
