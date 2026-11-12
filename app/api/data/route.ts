import { asc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { appUsers, reflectionAssignments, rosterMetadata, students } from "@/db/schema";
import { authenticatedApi, json } from "@/app/lib/reflection-api";
import { publicUserFields } from "@/app/lib/reflection-membership";
import { canCancelAutomaticFollowUp } from "@/app/lib/automatic-follow-up";
import { automaticFollowUpEvents, effectiveFollowUpSourceId, followUpsBySource } from "@/app/lib/follow-up-links";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return authenticatedApi(request, false, async (user) => {
    const db = getDb();
    const followUpEvents = automaticFollowUpEvents(db);
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
        rescheduledFromId: effectiveFollowUpSourceId(followUpEvents),
        automaticFollowUpId: followUpEvents.targetId,
      }).from(reflectionAssignments).leftJoin(followUpEvents, eq(followUpEvents.targetId, reflectionAssignments.id))
        .where(isNull(reflectionAssignments.cancelledAt))
        .orderBy(asc(reflectionAssignments.date), asc(reflectionAssignments.slot), asc(reflectionAssignments.createdAt)),
      db.select().from(rosterMetadata).where(eq(rosterMetadata.id, "roster")).limit(1),
    ]);
    const replacementsBySource = followUpsBySource(assignments);
    return json({
      students: roster,
      assignments: assignments.map(({ automaticFollowUpId: _automaticFollowUpId, ...assignment }) => {
        const replacements = replacementsBySource.get(assignment.id) ?? [];
        const correctable = replacements.length > 0 && replacements.every(replacement => canCancelAutomaticFollowUp(
          Boolean(replacement.automaticFollowUpId), replacement.status, replacement.attendanceRecordedAt,
          replacementsBySource.has(replacement.id),
        ));
        return {
          ...assignment,
          rescheduledToId: replacements[0]?.id ?? null,
          ...(replacements.length > 1 ? { rescheduledToIds: replacements.map(replacement => replacement.id) } : {}),
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
