import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { reflectionAssignments, students } from "@/db/schema";
import { ApiError, authenticatedApi, json, readJson } from "@/app/lib/reflection-api";
import { assignmentInput, chunks } from "@/app/lib/reflection-validation";
import { isUniqueConstraintError } from "@/app/lib/reflection-errors";
import { activityRowsStatement, sessionLabel } from "@/app/lib/reflection-activity";

export async function POST(request: Request) {
  return authenticatedApi(request, true, async (user) => {
    const input = assignmentInput(await readJson(request), user.displayName);
    const db = getDb();
    const knownIds = new Set<string>();
    for (const group of chunks(input.studentIds, 90)) {
      const matches = await db.select({ id: students.id }).from(students).where(and(inArray(students.id, group), eq(students.active, true)));
      matches.forEach((row) => knownIds.add(row.id));
    }
    if (input.studentIds.some((id) => !knownIds.has(id))) {
      throw new ApiError(400, "A selected student is archived or no longer in the directory. Refresh and try again.");
    }

    async function bookingConflictMessage(): Promise<string> {
      const booked = new Set<string>();
      for (const group of chunks(input.studentIds, 90)) {
        const matches = await db.select({ name: students.name, className: students.className })
          .from(reflectionAssignments).innerJoin(students, eq(reflectionAssignments.studentId, students.id))
          .where(and(
            inArray(reflectionAssignments.studentId, group),
            eq(reflectionAssignments.date, input.date),
            inArray(reflectionAssignments.slot, input.slots),
            isNull(reflectionAssignments.cancelledAt),
          ));
        matches.forEach((row) => booked.add(`${row.name} (${row.className})`));
      }
      if (!booked.size) return "";
      const names = [...booked];
      return `Already booked for a selected session: ${names.slice(0, 5).join(", ")}${names.length > 5 ? ` and ${names.length - 5} more` : ""}. Refresh and choose another session.`;
    }
    const existingConflict = await bookingConflictMessage();
    if (existingConflict) throw new ApiError(409, existingConflict);

    const now = new Date().toISOString();
    const rows = input.studentIds.flatMap((studentId) => input.slots.map((slot) => ({
      id: crypto.randomUUID(),
      studentId,
      date: input.date,
      slot,
      reason: input.reason,
      assignedBy: input.assignedBy,
      status: "pending" as const,
      createdAt: now,
      updatedAt: now,
      createdByUserId: user.userId,
      updatedByUserId: user.userId,
    })));

    // Small inserts keep each prepared statement below D1's bind-parameter limit.
    const statements = chunks(rows, 7).map((group) => db.insert(reflectionAssignments).values(group).returning({ id: reflectionAssignments.id }));
    const auditStatements = chunks(rows, 10).map(group => activityRowsStatement(user, group.map(row => ({
      action: "reflection.assigned", targetType: "reflection", targetId: row.id,
      targetName: sql`(SELECT name FROM students WHERE id = ${row.studentId})`,
      details: `${row.date} · ${sessionLabel(row.slot)}`, createdAt: now,
    }))));
    // D1 batches commit together, so a failed request does not leave half a register.
    try {
      const saved = await db.batch([statements[0], ...statements.slice(1), ...auditStatements]);
      const created = saved.slice(0, statements.length).reduce((total, result) => total + (Array.isArray(result) ? result.length : 0), 0);
      return json({ ok: true, created, skipped: 0 });
    } catch (error) {
      if (isUniqueConstraintError(error)) throw new ApiError(409, await bookingConflictMessage() || "A selected session was just booked by another staff member. Refresh and try again.");
      throw error;
    }
  });
}
