import { asc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { appUsers, reflectionAssignments, staffGoogleIdentities, students } from "@/db/schema";
import { authenticatedApi, json } from "@/app/lib/reflection-api";
import { requireInsightsAccess } from "@/app/lib/reflection-membership";
import { insightAttribution } from "@/app/lib/reflection-insights";
import { automaticFollowUpEvents, effectiveFollowUpSourceId } from "@/app/lib/follow-up-links";
import { reflectionReasonCategory } from "@/app/lib/reflection-reasons";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return authenticatedApi(request, false, async (user) => {
    requireInsightsAccess(user);
    const db = getDb();
    const followUpEvents = automaticFollowUpEvents(db);
    const [roster, assignments, staff, googleLinks] = await Promise.all([
      db.select({ id: students.id, name: students.name, grade: students.grade, className: students.className, active: students.active })
        .from(students).orderBy(asc(students.grade), asc(students.className), asc(students.name)),
      db.select({
        id: reflectionAssignments.id, studentId: reflectionAssignments.studentId,
        date: reflectionAssignments.date, slot: reflectionAssignments.slot,
        status: reflectionAssignments.status, assignedBy: reflectionAssignments.assignedBy,
        reason: reflectionAssignments.reason,
        createdAt: reflectionAssignments.createdAt, rescheduledFromId: effectiveFollowUpSourceId(followUpEvents),
        createdByUserId: reflectionAssignments.createdByUserId,
      }).from(reflectionAssignments).leftJoin(followUpEvents, eq(followUpEvents.targetId, reflectionAssignments.id))
        .where(isNull(reflectionAssignments.cancelledAt))
        .orderBy(asc(reflectionAssignments.date), asc(reflectionAssignments.slot), asc(reflectionAssignments.createdAt), asc(reflectionAssignments.id)),
      db.select({
        id: appUsers.id, name: appUsers.name, role: appUsers.role, status: appUsers.status,
        deletedAt: appUsers.deletedAt, linkedUserId: appUsers.linkedUserId,
      }).from(appUsers),
      db.select({ subject: staffGoogleIdentities.subject, memberId: staffGoogleIdentities.memberId }).from(staffGoogleIdentities),
    ]);
    const attributed = await insightAttribution(assignments, staff, googleLinks);
    const categories = new Map(assignments.map(({ id, reason }) => [id, reflectionReasonCategory(reason)]));
    return json({
      students: roster,
      ...attributed,
      assignments: attributed.assignments.map(assignment => ({
        ...assignment,
        reasonCategory: categories.get(assignment.id),
      })),
      user: { name: user.displayName, email: user.email, role: user.role },
    });
  });
}
