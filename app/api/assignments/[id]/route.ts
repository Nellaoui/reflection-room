import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { reflectionAssignments } from "@/db/schema";
import { ApiError, authenticatedApi, json, readJson } from "@/app/lib/reflection-api";
import { attendanceInput, validId } from "@/app/lib/reflection-validation";
import { activityStatement } from "@/app/lib/reflection-activity";
import { recordReflectionAttendance } from "@/app/lib/automatic-follow-up";
import { activeExtraFollowUpExists } from "@/app/lib/follow-up-links";

type RouteContext = { params: Promise<{ id: string }> };

function noActiveReplacement(id: string) {
  return sql`NOT EXISTS (SELECT 1 FROM reflection_assignments child WHERE child.rescheduled_from_id = ${id} AND child.cancelled_at IS NULL)
    AND NOT ${activeExtraFollowUpExists(id)}`;
}

function reflectionName(id: string) {
  return sql`(SELECT pupil.name FROM reflection_assignments reflection INNER JOIN students pupil ON pupil.id = reflection.student_id WHERE reflection.id = ${id})`;
}

function reflectionDetails(id: string) {
  return sql`(SELECT date || ' · ' || CASE WHEN slot = 'morning' THEN 'Morning break' ELSE 'Lunch break' END FROM reflection_assignments WHERE id = ${id})`;
}

async function assignmentMutationError(id: string): Promise<never> {
  const [assignment] = await getDb().select({ id: reflectionAssignments.id }).from(reflectionAssignments)
    .where(and(eq(reflectionAssignments.id, id), isNull(reflectionAssignments.cancelledAt))).limit(1);
  if (assignment) throw new ApiError(409, "Cancel the replacement session before changing its original missed reflection.");
  throw new ApiError(404, "This reflection session could not be found. Refresh the register.");
}

export async function PATCH(request: Request, context: RouteContext) {
  return authenticatedApi(request, true, async (user) => {
    const id = validId((await context.params).id);
    const status = attendanceInput(await readJson(request));
    return json({ ok: true, ...await recordReflectionAttendance(getDb(), user, id, status) });
  });
}

export async function DELETE(request: Request, context: RouteContext) {
  return authenticatedApi(request, true, async (user) => {
    const id = validId((await context.params).id);
    const now = new Date().toISOString();
    const db = getDb();
    const [result] = await db.batch([db.update(reflectionAssignments).set({
      cancelledAt: now,
      cancelledByUserId: user.userId,
      updatedAt: now,
      updatedByUserId: user.userId,
    }).where(and(eq(reflectionAssignments.id, id), isNull(reflectionAssignments.cancelledAt), noActiveReplacement(id)))
      .returning({ id: reflectionAssignments.id }), activityStatement(user, {
        action: "reflection.cancelled", targetType: "reflection", targetId: id,
        targetName: reflectionName(id), details: reflectionDetails(id), createdAt: now,
      }, true)]);
    if (!result.length) await assignmentMutationError(id);
    return json({ ok: true });
  });
}
