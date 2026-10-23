import type { AttendanceStatus, ReflectionSlot, StaffRole, StaffStatus } from "@/app/lib/reflection-validation";

export type InsightStudent = { id: string; name: string; grade: string; className: string; active: boolean };
export type InsightAssignment = {
  id: string; studentId: string; date: string; slot: ReflectionSlot;
  status: AttendanceStatus; assignedBy: string; createdAt: string;
  rescheduledFromId: string | null; rescheduledToId: string | null; teacherId: string;
};
export type InsightTeacher = {
  id: string; name: string; role: StaffRole | "historical";
  status: StaffStatus | "historical"; deleted: boolean;
};

type SourceAssignment = Omit<InsightAssignment, "rescheduledToId" | "teacherId"> & { createdByUserId: string };
type SourceStaff = { id: string; name: string; role: StaffRole; status: StaffStatus; deletedAt: string | null; linkedUserId: string | null };
type GoogleLink = { subject: string; memberId: string };

function staffName(value: string, fallback: string): string {
  // A missing Google display name may historically have been stored as an email.
  // Account emails and provider identifiers do not belong in the insights feed.
  return !value.trim() || /[^\s@]+@[^\s@]+\.[^\s@]+/.test(value) ? fallback : value;
}

async function historicalId(creator: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`reflection-room:historical-creator:${creator}`));
  return `historical_${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

// Identity links, not names or email guesses, define the teacher grouping. A
// renamed, disabled or deleted member keeps the same staff ID and history.
export async function insightAttribution(assignments: SourceAssignment[], staff: SourceStaff[], googleLinks: GoogleLink[]): Promise<{ assignments: InsightAssignment[]; teachers: InsightTeacher[] }> {
  const memberById = new Map(staff.map(member => [member.id, member]));
  const owners = new Map<string, Set<string>>();
  const link = (identity: string, memberId: string) => {
    if (!identity || !memberById.has(memberId)) return;
    const matches = owners.get(identity) ?? new Set<string>();
    matches.add(memberId);
    owners.set(identity, matches);
  };
  for (const member of staff) if (member.linkedUserId) link(member.linkedUserId, member.id);
  for (const identity of googleLinks) link(`google:${identity.subject}`, identity.memberId);
  const teachers = new Map<string, InsightTeacher>();
  const includeMember = (member: SourceStaff) => {
    teachers.set(member.id, { id: member.id, name: staffName(member.name, "Staff member"), role: member.role, status: member.status, deleted: !!member.deletedAt });
  };
  for (const member of staff) {
    if ((member.role === "teacher" || member.role === "moderator") && !member.deletedAt) includeMember(member);
  }
  const replacements = new Map(assignments.filter(assignment => assignment.rescheduledFromId)
    .map(assignment => [assignment.rescheduledFromId, assignment.id]));
  const historical = new Map<string, string>();
  const result: InsightAssignment[] = [];
  for (const assignment of assignments) {
    const matches = owners.get(assignment.createdByUserId);
    const member = matches?.size === 1 ? memberById.get([...matches][0]) : undefined;
    let teacherId: string;
    if (member) {
      teacherId = member.id;
      includeMember(member);
    } else {
      // An empty legacy creator cannot prove that two records share an actor.
      const creator = assignment.createdByUserId || `unidentified-assignment:${assignment.id}`;
      teacherId = historical.get(creator) ?? await historicalId(creator);
      historical.set(creator, teacherId);
      if (!teachers.has(teacherId)) teachers.set(teacherId, {
        id: teacherId, name: staffName(assignment.assignedBy, "Historical staff"),
        role: "historical", status: "historical", deleted: false,
      });
    }
    result.push({
      id: assignment.id, studentId: assignment.studentId, date: assignment.date,
      slot: assignment.slot, status: assignment.status,
      assignedBy: staffName(assignment.assignedBy, "Historical staff"), createdAt: assignment.createdAt,
      rescheduledFromId: assignment.rescheduledFromId,
      rescheduledToId: replacements.get(assignment.id) ?? null, teacherId,
    });
  }
  return {
    assignments: result,
    teachers: [...teachers.values()].sort((a, b) => a.name.localeCompare(b.name, "en") || a.id.localeCompare(b.id)),
  };
}
