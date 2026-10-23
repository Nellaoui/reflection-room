import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { reflectionAssignments, students } from "@/db/schema";
import { ApiError, authenticatedApi, json, readJson } from "@/app/lib/reflection-api";
import { isUniqueConstraintError } from "@/app/lib/reflection-errors";
import { rescheduleInput, validId } from "@/app/lib/reflection-validation";
import { activityStatement, sessionLabel } from "@/app/lib/reflection-activity";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  return authenticatedApi(request, true, async (user) => {
    const sourceId = validId((await context.params).id);
    const input = rescheduleInput(await readJson(request));
    const db = getDb();
    const [source] = await db.select({
      id: reflectionAssignments.id,
      date: reflectionAssignments.date,
      slot: reflectionAssignments.slot,
      status: reflectionAssignments.status,
      studentActive: students.active,
    }).from(reflectionAssignments).innerJoin(students, eq(reflectionAssignments.studentId, students.id))
      .where(and(eq(reflectionAssignments.id, sourceId), isNull(reflectionAssignments.cancelledAt))).limit(1);
    if (!source) throw new ApiError(404, "This missed reflection could not be found. Refresh the list.");
    if (source.status !== "absent") throw new ApiError(400, "Only a session marked absent can be rescheduled.");
    if (!source.studentActive) throw new ApiError(400, "This student is archived. Ask an administrator to restore the student first.");
    if (input.date < source.date) throw new ApiError(400, "The replacement date cannot be before the original reflection.");
    if (input.date === source.date && input.slot === source.slot) throw new ApiError(409, "Choose a different date or break from the original missed reflection.");

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    try {
      // One serialized SQL statement checks the source and its active child while
      // creating a single replacement. Partial unique indexes protect both the
      // target slot and the source if another staff request arrives concurrently.
      const [created] = await db.batch([db.insert(reflectionAssignments).select(sql`
        SELECT ${id}, original.student_id, ${input.date}, ${input.slot}, original.reason,
          ${user.displayName}, 'pending', ${now}, ${now}, ${user.userId}, ${user.userId},
          NULL, NULL, NULL, NULL, original.id
        FROM reflection_assignments original
        INNER JOIN students pupil ON pupil.id = original.student_id
        WHERE original.id = ${sourceId}
          AND original.status = 'absent' AND original.cancelled_at IS NULL AND pupil.active = 1
          AND original.date <= ${input.date}
          AND NOT EXISTS (
            SELECT 1 FROM reflection_assignments replacement
            WHERE replacement.rescheduled_from_id = original.id AND replacement.cancelled_at IS NULL
          )
      `).returning({ id: reflectionAssignments.id }), activityStatement(user, {
        action: "reflection.rescheduled", targetType: "reflection", targetId: id,
        targetName: sql`(SELECT pupil.name FROM reflection_assignments reflection INNER JOIN students pupil ON pupil.id = reflection.student_id WHERE reflection.id = ${id})`,
        details: `${source.date} · ${sessionLabel(source.slot)} → ${input.date} · ${sessionLabel(input.slot)}`,
        createdAt: now,
      }, true)]);
      if (!created.length) throw new ApiError(409, "This missed reflection has changed or already has a replacement. Refresh the list.");
      return json({ ok: true, assignmentId: created[0].id, sourceAssignmentId: sourceId });
    } catch (error) {
      if (isUniqueConstraintError(error)) throw new ApiError(409, "This student already has the chosen session, or the missed reflection was just rescheduled. Refresh and choose another session.");
      throw error;
    }
  });
}
