export const REPORT_TIME_ZONE = "Africa/Casablanca";
export type ReportAssignment = {
  id: string; studentId: string; date: string;
  status: "pending" | "present" | "absent";
  rescheduledFromId?: string | null; cancelledAt?: string | null;
  teacherId?: string; grade?: string; className?: string; reasonRecorded?: boolean;
  studentName?: string; teacherName?: string;
};
export type WeeklyReportMetrics = {
  initial: number; followUps: number; total: number; students: number;
  present: number; absent: number; pending: number; missedAwaitingFollowUp: number;
  studentsWithRepeatedReferralDays: number; studentsWithRepeatedAbsences: number;
  referringTeachers: number; largestTeacherShare: number | null; initialSessionsWithoutReason: number;
};
export type WeeklyReport = {
  weekKey: string;
  period: { start: string; end: string; label: string; asOf: string; timeZone: string };
  metrics: WeeklyReportMetrics;
  patterns: {
    classes: { grade: string; className: string; initial: number; students: number; absent: number }[];
    grades: { grade: string; initial: number; absent: number }[];
    previousWeek: { start: string; end: string; initial: number; absent: number; initialChange: number; absentChange: number };
    suggestedActions: string[];
  };
  tables: {
    students: { name: string; grade: string; className: string; initial: number; referralDays: number; followUps: number; present: number; absent: number; pending: number; missedAwaitingFollowUp: number }[];
    teachers: { name: string; initial: number; students: number; followUps: number; present: number; absent: number; pending: number }[];
    studentCount: number;
  };
  dashboardUrl: string;
  subject: string; text: string; html: string;
};
export type WeeklyReportReadiness = {
  enabled: boolean; ready: boolean; missing: string[];
  recipients: string[]; from: string | null; appUrl: string | null;
};
type ReportEnvironment = Record<string, string | undefined>;

export function casablancaClock(now: Date) {
  if (!Number.isFinite(now.getTime())) throw new Error("A valid report time is required.");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: REPORT_TIME_ZONE, calendar: "iso8601", numberingSystem: "latn",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: string) => parts.find(item => item.type === type)!.value;
  const date = `${part("year")}-${part("month")}-${part("day")}`;
  return { date, hour: Number(part("hour")), minute: Number(part("minute")), weekday: new Date(`${date}T12:00:00Z`).getUTCDay() };
}

function shiftDate(date: string, days: number) {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function reportWeek(now: Date) {
  const clock = casablancaClock(now);
  const start = shiftDate(clock.date, -((clock.weekday + 6) % 7));
  const end = shiftDate(start, 4);
  const labelDate = (value: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }).format(new Date(`${value}T12:00:00Z`));
  const asOf = new Intl.DateTimeFormat("en-GB", { timeZone: REPORT_TIME_ZONE, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  return { start, end, label: `${labelDate(start)} – ${labelDate(end)}`, asOf, timeZone: REPORT_TIME_ZONE };
}

// Friday afternoon only. The proposed UTC schedule has headroom before 16:00
// across Morocco's seasonal UTC-offset changes; delivery remains best-effort.
export function isWeeklyReportWindow(now: Date): boolean {
  const clock = casablancaClock(now);
  return clock.weekday === 5 && clock.hour >= 14 && clock.hour < 16;
}

function safeOrigin(value: string | undefined, allowLocal = false): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null;
    if (url.protocol !== "https:" && !(allowLocal && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) return null;
    return url.origin;
  } catch { return null; }
}

function emailAddress(value: string): boolean {
  return value.length <= 254 && /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(value);
}

export function weeklyReportReadiness(env: ReportEnvironment): WeeklyReportReadiness {
  const missing: string[] = [];
  const raw = env.WEEKLY_REPORT_RECIPIENTS?.trim() || "";
  const entries = raw.split(/[,;\s]+/).filter(Boolean).map(value => value.toLowerCase());
  const recipientsValid = entries.length > 0 && entries.length <= 30 && entries.every(emailAddress);
  const recipients = recipientsValid ? [...new Set(entries)] : [];
  if (!recipientsValid) missing.push("Approved recipients");
  const rawFrom = env.WEEKLY_REPORT_FROM?.trim() || "";
  const senderMatch = rawFrom.match(/^[^<>\r\n]{1,80} <([^<>\s]+)>$/);
  const senderAddress = senderMatch?.[1] || rawFrom;
  const from = !/[\r\n]/.test(rawFrom) && emailAddress(senderAddress) ? rawFrom : null;
  if (!from) missing.push("Verified school sender");
  const appUrl = safeOrigin(env.WEEKLY_REPORT_APP_URL);
  if (!appUrl) missing.push("Published website URL");
  if (!env.RESEND_API_KEY?.trim()) missing.push("Email service connection");
  if (!env.CRON_SECRET || env.CRON_SECRET.length < 16) missing.push("Schedule authentication");
  const enabled = env.WEEKLY_REPORT_ENABLED === "true";
  return { enabled, ready: enabled && !missing.length, missing, recipients, from, appUrl };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!));
}

function displayName(value: string | undefined, fallback: string): string {
  const cleaned = value?.normalize("NFKC").replace(/\s+/g, " ").trim();
  return !cleaned || /[^\s@]+@[^\s@]+\.[^\s@]+/.test(cleaned) ? fallback : cleaned.slice(0, 120);
}

export function buildWeeklyReport(assignments: ReportAssignment[], { now = new Date(), appUrl }: { now?: Date; appUrl: string }): WeeklyReport {
  const origin = safeOrigin(appUrl, true);
  if (!origin) throw new Error("A valid report website URL is required.");
  const period = reportWeek(now);
  const unique = [...new Map(assignments.map(assignment => [assignment.id, assignment])).values()];
  const active = unique.filter(assignment => !assignment.cancelledAt);
  const sessions = active.filter(assignment => assignment.date >= period.start && assignment.date <= period.end);
  const followedUp = new Set(active.map(assignment => assignment.rescheduledFromId).filter(Boolean));
  const followUps = sessions.filter(assignment => !!assignment.rescheduledFromId).length;
  const initialSessions = sessions.filter(assignment => !assignment.rescheduledFromId);
  const byStudent = new Map<string, { name: string; grade: string; className: string; initialDates: Set<string>; initial: number; followUps: number; present: number; absent: number; pending: number; missedAwaitingFollowUp: number }>();
  const byTeacher = new Map<string, number>();
  const teacherRows = new Map<string, { name: string; initial: number; students: Set<string>; followUps: number; present: number; absent: number; pending: number }>();
  const byClass = new Map<string, { grade: string; className: string; initial: number; absent: number; students: Set<string> }>();
  const byGrade = new Map<string, { grade: string; initial: number; absent: number }>();
  for (const assignment of sessions) {
    const student = byStudent.get(assignment.studentId) || { name: displayName(assignment.studentName, "Student record"), grade: assignment.grade || "Grade not recorded", className: assignment.className || "Class not recorded", initialDates: new Set<string>(), initial: 0, followUps: 0, present: 0, absent: 0, pending: 0, missedAwaitingFollowUp: 0 };
    if (!assignment.rescheduledFromId) { student.initialDates.add(assignment.date); student.initial++; } else student.followUps++;
    student[assignment.status]++;
    if (assignment.status === "absent" && !followedUp.has(assignment.id)) student.missedAwaitingFollowUp++;
    byStudent.set(assignment.studentId, student);
    if (!assignment.rescheduledFromId && assignment.teacherId) byTeacher.set(assignment.teacherId, (byTeacher.get(assignment.teacherId) || 0) + 1);
    if (assignment.teacherId) {
      const teacher = teacherRows.get(assignment.teacherId) || { name: displayName(assignment.teacherName, "Historical staff"), initial: 0, students: new Set<string>(), followUps: 0, present: 0, absent: 0, pending: 0 };
      if (assignment.rescheduledFromId) teacher.followUps++; else teacher.initial++;
      teacher.students.add(assignment.studentId); teacher[assignment.status]++;
      teacherRows.set(assignment.teacherId, teacher);
    }
    const grade = assignment.grade || "Grade not recorded";
    const className = assignment.className || "Class not recorded";
    const classKey = JSON.stringify([grade, className]);
    const classRow = byClass.get(classKey) || { grade, className, initial: 0, absent: 0, students: new Set<string>() };
    const gradeRow = byGrade.get(grade) || { grade, initial: 0, absent: 0 };
    if (!assignment.rescheduledFromId) { classRow.initial++; gradeRow.initial++; }
    if (assignment.status === "absent") { classRow.absent++; gradeRow.absent++; }
    classRow.students.add(assignment.studentId);
    byClass.set(classKey, classRow); byGrade.set(grade, gradeRow);
  }
  const previousStart = shiftDate(period.start, -7);
  const previousEnd = shiftDate(period.end, -7);
  const previousSessions = active.filter(assignment => assignment.date >= previousStart && assignment.date <= previousEnd);
  const previousInitial = previousSessions.filter(assignment => !assignment.rescheduledFromId).length;
  const previousAbsent = previousSessions.filter(assignment => assignment.status === "absent").length;
  const metrics: WeeklyReportMetrics = {
    initial: sessions.length - followUps, followUps, total: sessions.length,
    students: new Set(sessions.map(assignment => assignment.studentId)).size,
    present: sessions.filter(assignment => assignment.status === "present").length,
    absent: sessions.filter(assignment => assignment.status === "absent").length,
    pending: sessions.filter(assignment => assignment.status === "pending").length,
    missedAwaitingFollowUp: sessions.filter(assignment => assignment.status === "absent" && !followedUp.has(assignment.id)).length,
    studentsWithRepeatedReferralDays: [...byStudent.values()].filter(student => student.initialDates.size >= 2).length,
    studentsWithRepeatedAbsences: [...byStudent.values()].filter(student => student.absent >= 2).length,
    referringTeachers: byTeacher.size,
    largestTeacherShare: initialSessions.length && byTeacher.size ? Math.round(Math.max(...byTeacher.values()) / initialSessions.length * 100) : null,
    initialSessionsWithoutReason: initialSessions.filter(assignment => assignment.reasonRecorded === false).length,
  };
  const suggestedActions: string[] = [];
  if (metrics.studentsWithRepeatedReferralDays) suggestedActions.push(`Arrange supportive check-ins for the ${metrics.studentsWithRepeatedReferralDays} students with initial reflections scheduled on two or more separate days.`);
  if (metrics.missedAwaitingFollowUp || metrics.studentsWithRepeatedAbsences) suggestedActions.push("Cross-check missed sessions with school attendance before agreeing follow-up sessions with phase leaders.");
  if (metrics.initial) suggestedActions.push("Discuss class and teacher patterns alongside class size, timetable and existing support before drawing conclusions.");
  if (metrics.initialSessionsWithoutReason) suggestedActions.push("Follow up missing reason records with the referring staff.");
  const patterns = {
    classes: [...byClass.values()].filter(row => row.initial || row.absent).map(row => ({ ...row, students: row.students.size }))
      .sort((a, b) => b.initial - a.initial || b.absent - a.absent || a.grade.localeCompare(b.grade) || a.className.localeCompare(b.className)).slice(0, 3),
    grades: [...byGrade.values()].filter(row => row.initial || row.absent).sort((a, b) => b.initial - a.initial || b.absent - a.absent || a.grade.localeCompare(b.grade)).slice(0, 3),
    previousWeek: { start: previousStart, end: previousEnd, initial: previousInitial, absent: previousAbsent, initialChange: metrics.initial - previousInitial, absentChange: metrics.absent - previousAbsent },
    suggestedActions,
  };
  const tables = {
    students: [...byStudent.values()].map(student => ({
      name: student.name, grade: student.grade, className: student.className,
      initial: student.initial, referralDays: student.initialDates.size, followUps: student.followUps,
      present: student.present, absent: student.absent, pending: student.pending, missedAwaitingFollowUp: student.missedAwaitingFollowUp,
    })).sort((a, b) => b.referralDays - a.referralDays || b.absent - a.absent || b.initial - a.initial || a.name.localeCompare(b.name) || a.grade.localeCompare(b.grade) || a.className.localeCompare(b.className)),
    teachers: [...teacherRows.values()].map(teacher => ({ ...teacher, students: teacher.students.size }))
      .sort((a, b) => b.initial - a.initial || b.followUps - a.followUps || a.name.localeCompare(b.name)),
    studentCount: byStudent.size,
  };
  const dashboardUrl = `${origin}/moderator`;
  const subject = `Reflection Room — Weekly behaviour insights | ${period.label}`;
  const change = (value: number) => value > 0 ? `+${value}` : String(value);
  const classSummary = patterns.classes.length ? patterns.classes.map(row => `${row.grade} / ${row.className}: ${row.initial} initial, ${row.absent} absent`).join("; ") : "No class patterns recorded";
  const lines = [
    "Dear Mr Philip and Phase Leaders,", "",
    `Here are this week’s reflection patterns to support follow-up, as of ${period.asOf} Casablanca:`, "",
    "Student patterns",
    `• ${metrics.studentsWithRepeatedReferralDays} students had initial reflections scheduled on two or more separate days.`,
    `• ${metrics.studentsWithRepeatedAbsences} students missed two or more recorded sessions.`,
    `• ${metrics.missedAwaitingFollowUp} missed sessions still need a follow-up.`, "",
    "Teacher and class patterns",
    `• ${metrics.referringTeachers} staff assigned ${metrics.initial} initial sessions; ${metrics.followUps} follow-ups were scheduled separately. In total, ${metrics.students} students had sessions this week.`,
    `• Highest-volume classes: ${classSummary}.`,
    ...(metrics.largestTeacherShare === null ? [] : [`• The largest individual share of initial sessions was ${metrics.largestTeacherShare}%.`]),
    `• Compared with last week: initial sessions ${change(patterns.previousWeek.initialChange)}, recorded absences ${change(patterns.previousWeek.absentChange)}.`,
    `• Attendance: ${metrics.present} present, ${metrics.absent} absent, ${metrics.pending} pending.`,
    ...(metrics.initialSessionsWithoutReason ? [`• ${metrics.initialSessionsWithoutReason} initial sessions have no reason recorded.`] : []), "",
    "Suggested next steps",
    ...(suggestedActions.length ? suggestedActions.map(action => `• ${action}`) : ["No reflection sessions are recorded for this reporting week."]), "",
    "Student records for review (all students with sessions this week)",
    ...(tables.students.length ? tables.students.map(student => `${student.name} | ${student.grade} / ${student.className} | Initial: ${student.initial}; initial session days: ${student.referralDays}; follow-ups: ${student.followUps} | Present: ${student.present}; absent: ${student.absent}; pending: ${student.pending}; awaiting follow-up: ${student.missedAwaitingFollowUp}`) : ["No student sessions recorded this week."]), "",
    "Teacher assignment overview",
    ...(tables.teachers.length ? tables.teachers.map(teacher => `${teacher.name} | Initial: ${teacher.initial}; students: ${teacher.students}; follow-ups: ${teacher.followUps} | Present: ${teacher.present}; absent: ${teacher.absent}; pending: ${teacher.pending}`) : ["No teacher assignment activity recorded this week."]), "",
    "Review the complete student and teacher records in the secure insights dashboard:", dashboardUrl, "",
    "Kind regards,", "Reflection Room | London Academy", "",
    `Period: ${period.label}. Both breaks count separately. Follow-ups are separate from initial sessions.`,
    "Pending sessions are not counted as absences. Missed sessions awaiting follow-up are this week’s absences without an active replacement. Counts describe sessions, not incidents or judgements about students or teachers. Attendance outcomes belong to the sessions assigned; they do not identify who supervised them.",
  ];
  const text = lines.join("\n");
  const cell = "padding:12px;border:1px solid #dfe7d5;vertical-align:top;font-size:14px;line-height:1.7;overflow-wrap:anywhere";
  const heading = `${cell};background:#edf4e7;color:#173c2a;text-align:left`;
  const studentTable = tables.students.length ? `<table aria-label="Student records for review" style="width:100%;border-collapse:collapse;table-layout:fixed"><thead><tr><th scope="col" style="${heading}">Student</th><th scope="col" style="${heading}">Reflections</th><th scope="col" style="${heading}">Attendance and follow-up</th></tr></thead><tbody>${tables.students.map(student => `<tr><th scope="row" style="${cell};text-align:left;font-weight:normal"><strong>${escapeHtml(student.name)}</strong><br/>${escapeHtml(student.grade)} / ${escapeHtml(student.className)}</th><td style="${cell}">Initial sessions: ${student.initial}<br/>Initial session days: ${student.referralDays}<br/>Follow-ups: ${student.followUps}</td><td style="${cell}">Present: ${student.present}<br/>Absent: ${student.absent}<br/>Pending: ${student.pending}<br/>Awaiting follow-up: ${student.missedAwaitingFollowUp}</td></tr>`).join("")}</tbody></table>` : "<p>No student sessions recorded this week.</p>";
  const teacherTable = tables.teachers.length ? `<table aria-label="Teacher assignment overview" style="width:100%;border-collapse:collapse;table-layout:fixed"><thead><tr><th scope="col" style="${heading}">Teacher</th><th scope="col" style="${heading}">Assignments</th><th scope="col" style="${heading}">Session outcomes</th></tr></thead><tbody>${tables.teachers.map(teacher => `<tr><th scope="row" style="${cell};text-align:left;font-weight:normal"><strong>${escapeHtml(teacher.name)}</strong></th><td style="${cell}">Initial sessions: ${teacher.initial}<br/>Students: ${teacher.students}<br/>Follow-ups: ${teacher.followUps}</td><td style="${cell}">Present: ${teacher.present}<br/>Absent: ${teacher.absent}<br/>Pending: ${teacher.pending}</td></tr>`).join("")}</tbody></table>` : "<p>No teacher assignment activity recorded this week.</p>";
  const bodyStart = lines.indexOf("Student records for review (all students with sessions this week)");
  const summary = lines.slice(0, bodyStart).join("\n");
  const html = `<!doctype html><html lang="en"><body style="margin:0;background:#f8f9f4;color:#263b2c;font:16px/1.7 Arial,sans-serif"><main style="max-width:760px;margin:24px auto;padding:24px;background:#fff;border:1px solid #e2e7dc;border-top:4px solid #0e5403;border-radius:10px"><h1 style="font-size:26px;color:#173c2a">Reflection Room</h1><pre style="font:inherit;white-space:pre-wrap;overflow-wrap:anywhere">${escapeHtml(summary)}</pre><h2 style="font-size:20px">Student records for review</h2><p>All ${tables.studentCount} students with sessions this week, ordered by initial session days, recorded absences and initial sessions.</p>${studentTable}<h2 style="font-size:20px">Teacher assignment overview</h2>${teacherTable}<p>Review the complete records in the <a style="color:#0e5403" href="${escapeHtml(dashboardUrl)}">secure insights dashboard</a>.</p><p>Kind regards,<br/>Reflection Room | London Academy</p><p style="font-size:13px;color:#617054">${escapeHtml(lines[lines.length - 2])}<br/>${escapeHtml(lines[lines.length - 1])}</p></main></body></html>`;
  return { weekKey: period.start, period, metrics, patterns, tables, dashboardUrl, subject, text, html };
}
