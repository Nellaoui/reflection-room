import { and, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { appUsers, reflectionAssignments, staffGoogleIdentities, students, weeklyReportDeliveries } from "@/db/schema";
import { buildWeeklyReport, isWeeklyReportWindow, reportWeek, weeklyReportReadiness, type ReportAssignment, type WeeklyReport } from "@/app/lib/weekly-report";
import { insightAttribution } from "@/app/lib/reflection-insights";
import { automaticFollowUpEvents, effectiveFollowUpSourceId } from "@/app/lib/follow-up-links";

type ReportDb = ReturnType<typeof getDb>;
type Environment = Record<string, string | undefined>;
type FrozenEmail = { version: 1; from: string; to: string[]; subject: string; text: string; html: string; appUrl: string; idempotencyKey: string };
type DispatchResult = { status: "sent" | "skipped" | "retryable" | "uncertain"; reason?: string };
const LEASE_MS = 5 * 60_000;
// Resend keeps an idempotency key for 24h. Leave a conservative margin before
// any retry; older unknown outcomes need a provider-side review instead.
const SAFE_RETRY_MS = 23 * 60 * 60_000;
const assignmentFields = {
  id: reflectionAssignments.id, studentId: reflectionAssignments.studentId,
  date: reflectionAssignments.date, status: reflectionAssignments.status,
  cancelledAt: reflectionAssignments.cancelledAt,
  slot: reflectionAssignments.slot, assignedBy: reflectionAssignments.assignedBy,
  createdAt: reflectionAssignments.createdAt, createdByUserId: reflectionAssignments.createdByUserId,
  reasonRecorded: sql<boolean>`CASE WHEN length(trim(${reflectionAssignments.reason})) > 0 THEN 1 ELSE 0 END`.mapWith(Boolean),
  grade: students.grade, className: students.className, studentName: students.name,
};

export async function loadWeeklyReport(db: ReportDb, now: Date, appUrl: string): Promise<WeeklyReport> {
  const period = reportWeek(now);
  const previousStart = new Date(`${period.start}T12:00:00Z`);
  previousStart.setUTCDate(previousStart.getUTCDate() - 7);
  const followUpEvents = automaticFollowUpEvents(db);
  const rescheduledFromId = effectiveFollowUpSourceId(followUpEvents);
  const reportSessions = () => db.select({ ...assignmentFields, rescheduledFromId }).from(reflectionAssignments)
    .leftJoin(students, eq(reflectionAssignments.studentId, students.id))
    .leftJoin(followUpEvents, eq(followUpEvents.targetId, reflectionAssignments.id));
  const [sessions, staff, googleLinks] = await Promise.all([
    reportSessions().where(and(
      gte(reflectionAssignments.date, previousStart.toISOString().slice(0, 10)), lte(reflectionAssignments.date, period.end), isNull(reflectionAssignments.cancelledAt),
    )),
    db.select({ id: appUsers.id, name: appUsers.name, role: appUsers.role, status: appUsers.status, deletedAt: appUsers.deletedAt, linkedUserId: appUsers.linkedUserId }).from(appUsers),
    db.select({ subject: staffGoogleIdentities.subject, memberId: staffGoogleIdentities.memberId }).from(staffGoogleIdentities),
  ]);
  const replacements: typeof sessions = [];
  for (let index = 0; index < sessions.length; index += 90) {
    replacements.push(...await reportSessions().where(and(
      inArray(rescheduledFromId, sessions.slice(index, index + 90).map(item => item.id)), isNull(reflectionAssignments.cancelledAt),
    )));
  }
  const sourceRows = [...new Map([...sessions, ...replacements].map(row => [row.id, row])).values()];
  const attributed = await insightAttribution(sourceRows, staff, googleLinks);
  const sourceById = new Map(sourceRows.map(row => [row.id, row]));
  const teacherById = new Map(attributed.teachers.map(teacher => [teacher.id, teacher]));
  const reportRows: ReportAssignment[] = attributed.assignments.map(assignment => ({
    id: assignment.id, studentId: assignment.studentId, date: assignment.date, status: assignment.status,
    rescheduledFromId: assignment.rescheduledFromId, teacherId: assignment.teacherId,
    grade: sourceById.get(assignment.id)?.grade || undefined,
    className: sourceById.get(assignment.id)?.className || undefined,
    reasonRecorded: sourceById.get(assignment.id)?.reasonRecorded,
    studentName: sourceById.get(assignment.id)?.studentName || undefined,
    teacherName: teacherById.get(assignment.teacherId)?.name,
  }));
  return buildWeeklyReport(reportRows, { now, appUrl });
}

export async function weeklyReportPreview(db: ReportDb, { now = new Date(), env = process.env, previewOrigin }: { now?: Date; env?: Environment; previewOrigin: string }) {
  const readiness = weeklyReportReadiness(env);
  const preview = await loadWeeklyReport(db, now, readiness.appUrl || previewOrigin);
  const [lastDelivery] = await db.select({ weekKey: weeklyReportDeliveries.weekKey, status: weeklyReportDeliveries.status, attempts: weeklyReportDeliveries.attempts, updatedAt: weeklyReportDeliveries.updatedAt })
    .from(weeklyReportDeliveries).orderBy(desc(weeklyReportDeliveries.updatedAt)).limit(1).catch((error: unknown) => {
      // Deploying the read-only preview can precede the additive migration.
      // Only this missing table is recoverable; school-data and connection
      // failures must still fail, and sending still requires a ledger claim.
      if (!isMissingReportLedger(error)) throw error;
      readiness.ready = false;
      readiness.missing.push("Database update");
      return [];
    });
  return { preview, readiness, lastDelivery: lastDelivery || null };
}

function isMissingReportLedger(error: unknown): boolean {
  let current = error;
  const visited = new Set<object>();
  for (let depth = 0; depth < 8 && current && typeof current === "object" && !visited.has(current); depth++) {
    visited.add(current);
    const failure = current as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
    if ((failure.name === "LibsqlError" || failure.name === "SqliteError")
      && (failure.code === "SQLITE_ERROR" || failure.code === "SQLITE_UNKNOWN")
      && typeof failure.message === "string"
      && /^(?:SQLITE_(?:ERROR|UNKNOWN):\s*)?(?:SQLite error:\s*)?no such table:\s*(?:main\.)?weekly_report_deliveries$/i.test(failure.message.trim())) return true;
    current = failure.cause;
  }
  return false;
}

async function idempotencyKey(appUrl: string, weekKey: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(appUrl));
  const prefix = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 24);
  return `reflection-room-weekly/${prefix}/${weekKey}`;
}

function frozenEmail(payload: string): FrozenEmail | null {
  try {
    const email = JSON.parse(payload) as FrozenEmail;
    if (email.version !== 1 || typeof email.from !== "string" || !Array.isArray(email.to) || !email.to.every(item => typeof item === "string")
      || ![email.subject, email.text, email.html, email.appUrl, email.idempotencyKey].every(value => typeof value === "string" && value.length > 0)) return null;
    return email;
  } catch { return null; }
}

export async function dispatchWeeklyReport({ now = new Date(), env = process.env, db, fetcher = fetch }: { now?: Date; env?: Environment; db?: ReportDb; fetcher?: typeof fetch } = {}): Promise<DispatchResult> {
  const settings = weeklyReportReadiness(env);
  if (!settings.enabled) return { status: "skipped", reason: "disabled" };
  if (!settings.ready) return { status: "skipped", reason: "setup_required" };
  if (!isWeeklyReportWindow(now)) return { status: "skipped", reason: "outside_friday_afternoon" };
  const database = db || getDb();
  const timestamp = now.toISOString();
  const weekKey = reportWeek(now).start;
  const token = crypto.randomUUID();
  const report = await loadWeeklyReport(database, now, settings.appUrl!);
  const candidate: FrozenEmail = {
    version: 1, from: settings.from!, to: settings.recipients,
    subject: report.subject, text: report.text, html: report.html, appUrl: settings.appUrl!,
    idempotencyKey: await idempotencyKey(settings.appUrl!, weekKey),
  };
  let [delivery] = await database.insert(weeklyReportDeliveries).values({
    weekKey, periodStart: report.period.start, periodEnd: report.period.end,
    status: "sending", attemptToken: token, attempts: 1, payload: JSON.stringify(candidate),
    claimedAt: now.getTime(), createdAt: timestamp, updatedAt: timestamp,
  }).onConflictDoNothing({ target: weeklyReportDeliveries.weekKey }).returning();
  if (!delivery) {
    const [existing] = await database.select().from(weeklyReportDeliveries).where(eq(weeklyReportDeliveries.weekKey, weekKey)).limit(1);
    if (!existing) return { status: "uncertain", reason: "delivery_state_changed" };
    if (existing.status === "sent") return { status: "skipped", reason: "already_sent" };
    if (existing.status === "sending" && now.getTime() - existing.claimedAt < LEASE_MS) return { status: "skipped", reason: "in_progress" };
    const frozen = frozenEmail(existing.payload);
    // Current approval must still match the frozen recipient list and sender.
    // Never send to a removed recipient while retrying an older request.
    if (!frozen || frozen.from !== settings.from || frozen.appUrl !== settings.appUrl
      || JSON.stringify(frozen.to) !== JSON.stringify(settings.recipients)) {
      return { status: "uncertain", reason: "delivery_configuration_changed" };
    }
    const age = now.getTime() - Date.parse(existing.createdAt);
    if (existing.status !== "retryable" && (!Number.isFinite(age) || age < 0 || age >= SAFE_RETRY_MS)) {
      return { status: "uncertain", reason: "provider_review_required" };
    }
    [delivery] = await database.update(weeklyReportDeliveries).set({
      status: "sending", attemptToken: token, attempts: existing.attempts + 1,
      claimedAt: now.getTime(), updatedAt: timestamp, errorCode: null,
    }).where(and(eq(weeklyReportDeliveries.weekKey, weekKey), eq(weeklyReportDeliveries.attemptToken, existing.attemptToken), eq(weeklyReportDeliveries.status, existing.status))).returning();
    if (!delivery) return { status: "skipped", reason: "in_progress" };
  }
  const email = frozenEmail(delivery.payload);
  if (!email) return { status: "uncertain", reason: "invalid_delivery_snapshot" };
  async function finish(status: "sent" | "retryable" | "uncertain", errorCode: string | null, providerMessageId: string | null = null): Promise<DispatchResult> {
    try {
      const changed = await database.update(weeklyReportDeliveries).set({ status, errorCode, providerMessageId, updatedAt: now.toISOString() })
        .where(and(eq(weeklyReportDeliveries.weekKey, weekKey), eq(weeklyReportDeliveries.attemptToken, token), eq(weeklyReportDeliveries.status, "sending"))).returning({ weekKey: weeklyReportDeliveries.weekKey });
      return changed.length ? { status, ...(errorCode ? { reason: errorCode } : {}) } : { status: "uncertain", reason: "delivery_state_changed" };
    } catch {
      // The provider may already have accepted the email. Keep the original
      // snapshot/key and do not claim success or issue a different request.
      return { status: "uncertain", reason: "delivery_record_unavailable" };
    }
  }
  try {
    const response = await fetcher("https://api.resend.com/emails", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY!.trim()}`, "Content-Type": "application/json", "Idempotency-Key": email.idempotencyKey },
      body: JSON.stringify({ from: email.from, to: email.to, subject: email.subject, text: email.text, html: email.html }),
    });
    if (!response.ok) {
      const rejected = [400, 401, 403, 422, 429].includes(response.status);
      return finish(rejected ? "retryable" : "uncertain", rejected ? "provider_rejected" : "provider_confirmation_required");
    }
    let confirmation: { id?: unknown };
    try { confirmation = await response.json() as { id?: unknown }; } catch { return finish("uncertain", "provider_confirmation_required"); }
    if (typeof confirmation.id !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(confirmation.id)) return finish("uncertain", "provider_confirmation_required");
    return finish("sent", null, confirmation.id);
  } catch {
    return finish("uncertain", "provider_confirmation_required");
  }
}
