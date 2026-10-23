import { asc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { appUsers, reflectionAssignments, rosterMetadata, students } from "@/db/schema";
import { authenticatedApi, json } from "@/app/lib/reflection-api";
import { publicUserFields } from "@/app/lib/reflection-membership";

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
      }).from(reflectionAssignments).where(isNull(reflectionAssignments.cancelledAt))
        .orderBy(asc(reflectionAssignments.date), asc(reflectionAssignments.slot), asc(reflectionAssignments.createdAt)),
      db.select().from(rosterMetadata).where(eq(rosterMetadata.id, "roster")).limit(1),
    ]);
    const replacementBySource = new Map(assignments.filter((assignment) => assignment.rescheduledFromId)
      .map((assignment) => [assignment.rescheduledFromId, assignment.id]));
    return json({
      students: roster,
      assignments: assignments.map((assignment) => ({ ...assignment, rescheduledToId: replacementBySource.get(assignment.id) ?? null })),
      meta: {
        rosterSource: metadata[0]?.source ?? null,
        rosterImportedAt: metadata[0]?.importedAt ?? null,
      },
      user: { name: user.displayName, email: user.email, role: user.role },
      ...(user.role === "admin" ? { users: await db.select(publicUserFields).from(appUsers).where(isNull(appUsers.deletedAt)).orderBy(asc(appUsers.name)) } : {}),
    });
  });
}
