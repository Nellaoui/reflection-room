import { asc, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { appUsers, reflectionAssignments, rosterMetadata, students } from "@/db/schema";
import { authenticatedApi, json } from "@/app/lib/reflection-api";
import { publicUserFields } from "@/app/lib/reflection-membership";
import { automaticFollowUpAction, canCancelAutomaticFollowUp } from "@/app/lib/automatic-follow-up";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return authenticatedApi(request, false, async (user) => {
    const db = getDb();
    const [roster, assignments, metadata] = await Promise.all([
      db.select({ id: students.id, name: students.name, grade: students.grade, className: students.className, active: students.active, toddleId: students.toddleId })
        .from(students).orderBy(asc(students.grade), asc(students.className), asc(students.name)),
      db.select({
        id: reflectionAssignments.id,
        studentId: reflectionAssignments.studentId,
        date: reflectionAssignments.date,
        slot: reflectionAssignments.slot,
        reason: reflectionAssignments.reason,
        assignedBy: reflectionAssignments.assignedBy,
        status: reflectionAssignments.status,
        createdAt: reflectionAssignments.createdAt,
        attendanceRecordedBy: reflectionAssignments.attendanceRecordedBy,
        attendanceRecordedAt: reflectionAssignments.attendanceRecordedAt,
        rescheduledFromId: reflectionAssignments.rescheduledFromId,
        automaticFollowUp: sql<number>`${reflectionAssignments.rescheduledFromId} IS NOT NULL AND EXISTS (
          SELECT 1 FROM activity_events event
          WHERE event.target_id = reflection_assignments.id AND event.action = ${automaticFollowUpAction}
        )`,
      }).from(reflectionAssignments).where(isNull(reflectionAssignments.cancelledAt))
        .orderBy(asc(reflectionAssignments.date), asc(reflectionAssignments.slot), asc(reflectionAssignments.createdAt)),
      db.select().from(rosterMetadata).where(eq(rosterMetadata.id, "roster")).limit(1),
    ]);
    const replacementBySource = new Map(assignments.filter((assignment) => assignment.rescheduledFromId)
      .map((assignment) => [assignment.rescheduledFromId, assignment]));
    return json({
      students: roster,
      assignments: assignments.map(({ automaticFollowUp: _automaticFollowUp, ...assignment }) => {
        const replacement = replacementBySource.get(assignment.id);
        const correctable = replacement && canCancelAutomaticFollowUp(
          Boolean(replacement.automaticFollowUp), replacement.status, replacement.attendanceRecordedAt,
          replacementBySource.has(replacement.id),
        );
        return {
          ...assignment,
          rescheduledToId: replacement?.id ?? null,
          ...(correctable ? { canCorrectAttendance: true } : {}),
        };
      }),
      meta: {
        rosterSource: metadata[0]?.source ?? null,
        rosterImportedAt: metadata[0]?.importedAt ?? null,
      },
      user: { name: user.displayName, email: user.email, role: user.role },
      ...(user.role === "admin" ? { users: await db.select(publicUserFields).from(appUsers).where(isNull(appUsers.deletedAt)).orderBy(asc(appUsers.name)) } : {}),
    });
  });
}
