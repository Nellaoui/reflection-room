import { setTimeout } from "node:timers/promises";
import type { InStatement, Transaction } from "@libsql/client";
import type { getDb } from "@/db";
import { sessionLabel } from "@/app/lib/reflection-activity";
import { ApiError } from "@/app/lib/reflection-errors";
import type { StaffUser } from "@/app/lib/reflection-membership";
import type { AttendanceStatus } from "@/app/lib/reflection-validation";
import { nextSchoolDay } from "@/app/lib/school-calendar";
import { casablancaClock } from "@/app/lib/weekly-report";

export const automaticFollowUpAction = "reflection.auto_rescheduled";

type FollowUp = { id: string; date: string };
type AttendanceResult = {
  attendanceRecordedBy: string | null;
  attendanceRecordedAt: string | null;
  followUp: FollowUp | null;
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

async function availableLunch(transaction: Transaction, studentId: string, sourceDate: string, today: string) {
  let date = sourceDate < today ? nextSchoolDay(today, 1, true) : nextSchoolDay(sourceDate);
  if (!date) return null;

  const { rows } = await transaction.execute({
    sql: `SELECT date FROM reflection_assignments
          WHERE student_id = ? AND slot = 'lunch' AND cancelled_at IS NULL AND date >= ?`,
    args: [studentId, date],
  });
  const occupied = new Set(rows.map(row => String(row.date)));
  while (date && occupied.has(date)) date = nextSchoolDay(date);
  return date;
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
                   source.attendance_recorded_by, pupil.name AS student_name, pupil.active AS student_active,
                   child.id AS child_id, child.date AS child_date, child.status AS child_status,
                   child.attendance_recorded_at AS child_attendance_recorded_at,
                   EXISTS (SELECT 1 FROM activity_events event
                           WHERE event.target_id = child.id AND event.action = ?) AS child_automatic,
                   EXISTS (SELECT 1 FROM reflection_assignments later
                           WHERE later.rescheduled_from_id = child.id AND later.cancelled_at IS NULL) AS child_replaced
            FROM reflection_assignments source
            INNER JOIN students pupil ON pupil.id = source.student_id
            LEFT JOIN reflection_assignments child ON child.rescheduled_from_id = source.id AND child.cancelled_at IS NULL
            WHERE source.id = ? AND source.cancelled_at IS NULL`,
      args: [automaticFollowUpAction, id],
    });
    if (!source) throw new ApiError(404, "This reflection session could not be found. Refresh the register.");

    const studentName = String(source.student_name);
    const sourceDate = String(source.date);
    const sourceDetails = `${sourceDate} · ${sessionLabel(source.slot === "morning" ? "morning" : "lunch")}`;
    const childId = source.child_id === null ? null : String(source.child_id);
    const recordedAt = now.toISOString();
    const statements: InStatement[] = [];
    const result: AttendanceResult = {
      attendanceRecordedBy: source.attendance_recorded_by === null ? null : String(source.attendance_recorded_by),
      attendanceRecordedAt: source.attendance_recorded_at === null ? null : String(source.attendance_recorded_at),
      followUp: null,
      followUpUnavailable: null,
      followUpCancelled: false,
    };

    if (childId && status !== "absent") {
      if (!canCancelAutomaticFollowUp(Boolean(source.child_automatic), source.child_status, source.child_attendance_recorded_at, Boolean(source.child_replaced))) {
        throw new ApiError(409, "Cancel the replacement session before changing its original missed reflection.");
      }
      statements.push({
        sql: `UPDATE reflection_assignments SET cancelled_at = ?, cancelled_by_user_id = ?, updated_at = ?, updated_by_user_id = ?
              WHERE id = ?`,
        args: [recordedAt, user.userId, recordedAt, user.userId, childId],
      }, audit(user, "reflection.cancelled", childId, studentName,
        `Attendance corrected · ${source.child_date} · Lunch break`, recordedAt));
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
      if (childId) {
        result.followUp = { id: childId, date: String(source.child_date) };
      } else if (!source.student_active) {
        result.followUpUnavailable = "archived";
      } else {
        const date = await availableLunch(transaction, String(source.student_id), sourceDate, casablancaClock(now).date);
        if (date) {
          const followUpId = crypto.randomUUID();
          statements.push({
            sql: `INSERT INTO reflection_assignments (
                    id, student_id, date, slot, reason, assigned_by, status, created_at, updated_at,
                    created_by_user_id, updated_by_user_id, rescheduled_from_id
                  ) VALUES (?, ?, ?, 'lunch', ?, ?, 'pending', ?, ?, ?, ?, ?)`,
            args: [followUpId, source.student_id, date, source.reason, source.assigned_by, recordedAt, recordedAt,
              source.created_by_user_id, user.userId, id],
          }, audit(user, automaticFollowUpAction, followUpId, studentName,
            `${sourceDetails} → ${date} · Lunch break`, recordedAt));
          result.followUp = { id: followUpId, date };
        } else {
          result.followUpUnavailable = "calendar";
        }
      }
    }

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
