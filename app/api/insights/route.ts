import { asc, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { appUsers, reflectionAssignments, staffGoogleIdentities, students } from "@/db/schema";
import { authenticatedApi, json } from "@/app/lib/reflection-api";
import { requireInsightsAccess } from "@/app/lib/reflection-membership";
import { insightAttribution } from "@/app/lib/reflection-insights";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return authenticatedApi(request, false, async (user) => {
    requireInsightsAccess(user);
    const db = getDb();
    const [roster, assignments, staff, googleLinks] = await Promise.all([
      db.select({ id: students.id, name: students.name, grade: students.grade, className: students.className, active: students.active })
        .from(students).orderBy(asc(students.grade), asc(students.className), asc(students.name)),
      db.select({
        id: reflectionAssignments.id, studentId: reflectionAssignments.studentId,
        date: reflectionAssignments.date, slot: reflectionAssignments.slot,
        status: reflectionAssignments.status, assignedBy: reflectionAssignments.assignedBy,
        createdAt: reflectionAssignments.createdAt, rescheduledFromId: reflectionAssignments.rescheduledFromId,
        createdByUserId: reflectionAssignments.createdByUserId,
      }).from(reflectionAssignments).where(isNull(reflectionAssignments.cancelledAt))
        .orderBy(asc(reflectionAssignments.date), asc(reflectionAssignments.slot), asc(reflectionAssignments.createdAt), asc(reflectionAssignments.id)),
      db.select({
        id: appUsers.id, name: appUsers.name, role: appUsers.role, status: appUsers.status,
        deletedAt: appUsers.deletedAt, linkedUserId: appUsers.linkedUserId,
      }).from(appUsers),
      db.select({ subject: staffGoogleIdentities.subject, memberId: staffGoogleIdentities.memberId }).from(staffGoogleIdentities),
    ]);
    const attributed = await insightAttribution(assignments, staff, googleLinks);
    return json({
      students: roster,
      ...attributed,
      user: { name: user.displayName, email: user.email, role: user.role },
    });
  });
}
