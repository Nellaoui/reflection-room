import { createHash, randomUUID } from "node:crypto";
import type { InStatement, Transaction } from "@libsql/client";
import type { getDb } from "@/db";
import { ApiError } from "@/app/lib/reflection-errors";
import type { StaffUser } from "@/app/lib/reflection-membership";
import { nextReflectionDay } from "@/app/lib/school-calendar";
import { casablancaClock } from "@/app/lib/weekly-report";

type CutoverDatabase = Pick<ReturnType<typeof getDb>, "$client">;
type CutoverActor = Pick<StaffUser, "memberId" | "userId" | "displayName">;
type Booking = { id: string; studentName: string; fromDate: string };
type Move = Booking & { toDate: string };

export type LunchCutoverPlan = {
  planId: string;
  schoolDate: string;
  moves: Move[];
  blocked: Booking[];
};

async function planCutover(database: Pick<Transaction, "execute">, schoolDate: string): Promise<LunchCutoverPlan> {
  // One statement provides a consistent preview of morning bookings and the
  // relevant lunch reservations, including those with attendance recorded.
  const { rows } = await database.execute({
    sql: `WITH morning AS (
      SELECT id, student_id, date, slot, created_at
      FROM reflection_assignments
      WHERE slot = 'morning' AND status = 'pending' AND cancelled_at IS NULL
    ), bookings AS (
      SELECT * FROM morning
      UNION ALL
      SELECT id, student_id, date, slot, created_at
      FROM reflection_assignments
      WHERE slot = 'lunch' AND cancelled_at IS NULL AND date >= ?
        AND student_id IN (SELECT student_id FROM morning)
    )
    SELECT booking.id, booking.student_id, booking.date, booking.slot, pupil.name AS student_name
    FROM bookings booking JOIN students pupil ON pupil.id = booking.student_id
    ORDER BY booking.date, booking.created_at, booking.id`,
    args: [schoolDate],
  });

  const occupied = new Map<string, Set<string>>();
  for (const row of rows) {
    const studentId = String(row.student_id);
    if (!occupied.has(studentId)) occupied.set(studentId, new Set());
    if (row.slot === "lunch") occupied.get(studentId)!.add(String(row.date));
  }

  const moves: Move[] = [];
  const blocked: Booking[] = [];
  for (const row of rows) {
    if (row.slot !== "morning") continue;
    const fromDate = String(row.date);
    const booking = { id: String(row.id), studentName: String(row.student_name), fromDate };
    const reservedDays = occupied.get(String(row.student_id))!;
    const earliestDay = fromDate < schoolDate ? schoolDate : fromDate;
    let toDate = nextReflectionDay(earliestDay, true);
    while (toDate && reservedDays.has(toDate)) toDate = nextReflectionDay(toDate);
    if (!toDate) {
      blocked.push(booking);
      continue;
    }
    reservedDays.add(toDate);
    moves.push({ ...booking, toDate });
  }

  const plan = { schoolDate, moves, blocked };
  const planId = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
  return { planId, ...plan };
}

export async function previewLunchCutover(db: CutoverDatabase, now = new Date()): Promise<LunchCutoverPlan> {
  return planCutover(db.$client, casablancaClock(now).date);
}

export async function applyLunchCutover(
  db: CutoverDatabase,
  actor: CutoverActor,
  expectedPlanId: string,
  now = new Date(),
): Promise<LunchCutoverPlan & { moved: number }> {
  // A write transaction reserves SQLite's write lock before reading the plan.
  // Bookings cannot change between the recheck, the updates and the audit rows.
  const transaction = await db.$client.transaction("write");
  try {
    const plan = await planCutover(transaction, casablancaClock(now).date);
    if (plan.blocked.length) {
      throw new ApiError(409, "There are not enough available lunch dates in the verified school calendar. Update the calendar and review the moves again.");
    }
    if (!plan.moves.length) return { ...plan, moved: 0 };
    if (plan.planId !== expectedPlanId) {
      throw new ApiError(409, "The proposed moves have changed. Refresh and review the new dates before applying them.");
    }

    const timestamp = now.toISOString();
    for (let offset = 0; offset < plan.moves.length; offset += 25) {
      const statements: InStatement[] = plan.moves.slice(offset, offset + 25).flatMap(move => [{
        sql: `UPDATE reflection_assignments SET date = ?, slot = 'lunch', updated_at = ?, updated_by_user_id = ?
          WHERE id = ? AND date = ? AND slot = 'morning' AND status = 'pending' AND cancelled_at IS NULL`,
        args: [move.toDate, timestamp, actor.userId, move.id, move.fromDate],
      }, {
        sql: `INSERT INTO activity_events (id, actor_id, actor_name, action, target_type, target_id, target_name, details, created_at)
          VALUES (?, ?, ?, 'reflection.rescheduled', 'reflection', ?, ?, ?, ?)`,
        args: [randomUUID(), actor.memberId, actor.displayName, move.id, move.studentName,
          `${move.fromDate} · Morning break → ${move.toDate} · Lunch break`, timestamp],
      }]);
      const results = await transaction.batch(statements);
      if (results.some(result => result.rowsAffected !== 1)) {
        throw new ApiError(409, "A reflection changed during the move. Refresh and review the dates again.");
      }
    }
    await transaction.commit();
    return { ...plan, moved: plan.moves.length };
  } finally {
    try {
      if (!transaction.closed) await transaction.rollback();
    } catch {
      // Preserve the original failure if the connection cannot roll back.
    } finally {
      transaction.close();
    }
  }
}
