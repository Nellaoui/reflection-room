import { setTimeout } from "node:timers/promises";
import type { InStatement, Transaction } from "@libsql/client";
import type { getDb } from "@/db";
import { automaticExtraFollowUpAction, automaticFollowUpAction } from "@/app/lib/follow-up-links";
import { sessionLabel } from "@/app/lib/reflection-activity";
import { ApiError } from "@/app/lib/reflection-errors";
import type { StaffUser } from "@/app/lib/reflection-membership";
import type { AttendanceStatus } from "@/app/lib/reflection-validation";
import { nextSchoolDay, schoolCalendar } from "@/app/lib/school-calendar";
import { casablancaClock } from "@/app/lib/weekly-report";

const followUpCalendar = {
  ...schoolCalendar,
  closedWeekdays: [...new Set([...schoolCalendar.closedWeekdays, 0, 5, 6])],
};

type FollowUp = { id: string; date: string };
type AttendanceResult = {
  attendanceRecordedBy: string | null;
  attendanceRecordedAt: string | null;
  followUp: FollowUp | null;
  followUps: FollowUp[];
  followUpUnavailable: "archived" | "calendar" | null;
  followUpCancelled: boolean;
};

export function canCancelAutomaticFollowUp(
  automatic: boolean,
  status: unknown,
  attendanceRecordedAt: unknown,
  hasReplacement: boolean,
) {
  return automatic && status === "pending" && attendanceRecordedAt === null && !hasReplacement;
}

async function availableLunches(transaction: Transaction, studentId: string, sourceDate: string, today: string) {
  const afterDate = sourceDate < today ? today : sourceDate;
  let date = nextSchoolDay(afterDate, 1, false, followUpCalendar);
  if (!date) return null;

  const { rows } = await transaction.execute({
    sql: `SELECT date FROM reflection_assignments
          WHERE student_id = ? AND slot = 'lunch' AND cancelled_at IS NULL AND date >= ?`,
    args: [studentId, date],
  });
  const occupied = new Set(rows.map(row => String(row.date)));
  const dates: string[] = [];
  while (date) {
    if (!occupied.has(date)) {
      dates.push(date);
      if (dates.length === 2) return dates;
    }
    date = nextSchoolDay(date, 1, false, followUpCalendar);
  }
  return null;
}

async function activeFollowUps(transaction: Transaction, sourceId: string, studentId: string) {
  const { rows } = await transaction.execute({
    sql: `WITH extra_links AS (
            SELECT DISTINCT target_id,
              CASE WHEN json_valid(details) THEN json_extract(details, '$.sourceId') END AS source_id
            FROM activity_events
            WHERE action = ? AND target_type = 'reflection'
          )
          SELECT child.id, child.date, child.status, child.attendance_recorded_at,
                 extra.target_id IS NOT NULL OR EXISTS (
                   SELECT 1 FROM activity_events event WHERE event.target_id = child.id AND event.action = ?
                 ) AS automatic,
                 EXISTS (
                   SELECT 1 FROM reflection_assignments later
                   LEFT JOIN extra_links link ON link.target_id = later.id
                   WHERE later.cancelled_at IS NULL
                     AND (later.rescheduled_from_id = child.id OR link.source_id = child.id)
                 ) AS replaced
          FROM reflection_assignments child
          LEFT JOIN extra_links extra ON extra.target_id = child.id AND child.rescheduled_from_id IS NULL
          WHERE child.cancelled_at IS NULL AND child.student_id = ?
            AND (child.rescheduled_from_id = ? OR extra.source_id = ?)
          ORDER BY child.date, child.id`,
    args: [automaticExtraFollowUpAction, automaticFollowUpAction, studentId, sourceId, sourceId],
  });
  return rows;
}

function audit(user: StaffUser, action: string, id: string, studentName: string, details: string, timestamp: string): InStatement {
  return {
    sql: `INSERT INTO activity_events (id, actor_id, actor_name, action, target_type, target_id, target_name, details, created_at)
          VALUES (?, ?, ?, ?, 'reflection', ?, ?, ?, ?)`,
    args: [crypto.randomUUID(), user.memberId, user.displayName, action, id, studentName, details, timestamp],
  };
}

type AttendanceDatabase = Pick<ReturnType<typeof getDb>, "$client">;

export async function recordReflectionAttendance(
  db: AttendanceDatabase,
  user: StaffUser,
  id: string,
  status: AttendanceStatus,
  now = new Date(),
): Promise<AttendanceResult> {
  // A concurrent write may briefly hold the lock. Retry only when SQLite
  // reports contention, never after an uncertain connection failure.
  for (const delay of [0, 25, 100]) {
    if (delay) await setTimeout(delay);
    try {
      return await saveAttendance(db, user, id, status, now);
    } catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error)
        || !/^SQLITE_(BUSY|LOCKED)(_|$)/.test(String(error.code))) throw error;
    }
  }
  throw new ApiError(409, "Another change is in progress. Try recording attendance again.");
}

async function saveAttendance(
  db: AttendanceDatabase,
  user: StaffUser,
  id: string,
  status: AttendanceStatus,
  now: Date,
): Promise<AttendanceResult> {
  // Serialize the attendance edit with other booking and attendance writes so
  // the date and linked session are based on the same set of active bookings.
  const transaction = await db.$client.transaction("write");
  try {
    const { rows: [source] } = await transaction.execute({
      sql: `SELECT source.student_id, source.date, source.slot, source.status, source.reason,
                   source.assigned_by, source.created_by_user_id, source.attendance_recorded_at,
                   source.attendance_recorded_by, pupil.name AS student_name, pupil.active AS student_active
            FROM reflection_assignments source
            INNER JOIN students pupil ON pupil.id = source.student_id
            WHERE source.id = ? AND source.cancelled_at IS NULL`,
      args: [id],
    });
    if (!source) throw new ApiError(404, "This reflection session could not be found. Refresh the register.");

    const studentName = String(source.student_name);
    const sourceDate = String(source.date);
    const sourceDetails = `${sourceDate} · ${sessionLabel(source.slot === "morning" ? "morning" : "lunch")}`;
    const children = await activeFollowUps(transaction, id, String(source.student_id));
    const recordedAt = now.toISOString();
    const statements: InStatement[] = [];
    const result: AttendanceResult = {
      attendanceRecordedBy: source.attendance_recorded_by === null ? null : String(source.attendance_recorded_by),
      attendanceRecordedAt: source.attendance_recorded_at === null ? null : String(source.attendance_recorded_at),
      followUp: null,
      followUps: [],
      followUpUnavailable: null,
      followUpCancelled: false,
    };

    if (children.length && status !== "absent") {
      if (children.some(child => !canCancelAutomaticFollowUp(
        Boolean(child.automatic), child.status, child.attendance_recorded_at, Boolean(child.replaced),
      ))) {
        throw new ApiError(409, "Cancel the replacement sessions before changing their original missed reflection.");
      }
      for (const child of children) {
        const childId = String(child.id);
        statements.push({
          sql: `UPDATE reflection_assignments SET cancelled_at = ?, cancelled_by_user_id = ?, updated_at = ?, updated_by_user_id = ?
                WHERE id = ?`,
          args: [recordedAt, user.userId, recordedAt, user.userId, childId],
        }, audit(user, "reflection.cancelled", childId, studentName,
          `Attendance corrected · ${child.date} · Lunch break`, recordedAt));
      }
      result.followUpCancelled = true;
    }

    // Re-marking an absence retries an unresolved follow-up without rewriting
    // the recorded attendance or duplicating its audit entry.
    if (source.status !== status) {
      statements.push({
        sql: `UPDATE reflection_assignments
              SET status = ?, updated_at = ?, updated_by_user_id = ?, attendance_recorded_by = ?, attendance_recorded_at = ?
              WHERE id = ?`,
        args: [status, recordedAt, user.userId, user.displayName, recordedAt, id],
      }, audit(user, "attendance.recorded", id, studentName, `Marked ${status} · ${sourceDetails}`, recordedAt));
      result.attendanceRecordedBy = user.displayName;
      result.attendanceRecordedAt = recordedAt;
    }

    if (status === "absent") {
      if (children.length) {
        result.followUps = children.map(child => ({ id: String(child.id), date: String(child.date) }));
      } else if (!source.student_active) {
        result.followUpUnavailable = "archived";
      } else {
        const dates = await availableLunches(transaction, String(source.student_id), sourceDate, casablancaClock(now).date);
        if (dates) {
          for (const [index, date] of dates.entries()) {
            const followUpId = crypto.randomUUID();
            const summary = `${sourceDetails} → ${date} · Lunch break`;
            const extra = index === 1;
            // The first booking owns the single direct replacement link.
            // The extra's audit event links it to the same absence.
            statements.push({
              sql: `INSERT INTO reflection_assignments (
                      id, student_id, date, slot, reason, assigned_by, status, created_at, updated_at,
                      created_by_user_id, updated_by_user_id, rescheduled_from_id
                    ) VALUES (?, ?, ?, 'lunch', ?, ?, 'pending', ?, ?, ?, ?, ?)`,
              args: [followUpId, source.student_id, date, source.reason, source.assigned_by, recordedAt, recordedAt,
                source.created_by_user_id, user.userId, extra ? null : id],
            }, audit(user, extra ? automaticExtraFollowUpAction : automaticFollowUpAction, followUpId, studentName,
              extra ? JSON.stringify({ sourceId: id, summary }) : summary, recordedAt));
            result.followUps.push({ id: followUpId, date });
          }
        } else {
          result.followUpUnavailable = "calendar";
        }
      }
    }
    result.followUp = result.followUps[0] ?? null;

    if (statements.length) {
      await transaction.batch(statements);
      await transaction.commit();
    }
    return result;
  } finally {
    try {
      if (!transaction.closed) await transaction.rollback();
    } catch {
      // Preserve the original error if the connection cannot roll back.
    } finally {
      transaction.close();
    }
  }
}
