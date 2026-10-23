import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { activityEvents } from "@/db/schema";
import type { StaffUser } from "@/app/lib/reflection-membership";

export type ActivityAction =
  | "staff.created" | "staff.updated" | "staff.deleted"
  | "student.created" | "student.updated" | "student.archived"
  | "roster.imported" | "reflection.assigned" | "reflection.cancelled"
  | "reflection.rescheduled" | "attendance.recorded";

type ActivityInput = {
  action: ActivityAction | SQL;
  targetType: "staff" | "student" | "roster" | "reflection";
  targetId: string | SQL;
  targetName: string | SQL;
  details: string | SQL;
  createdAt?: string;
};

// Put this immediately after a conditional UPDATE in the same atomic batch.
// SQLite changes() then refers to that write, so failed/stale requests cannot
// manufacture success events. CREATE operations use the unconditional variant;
// any failure rolls back both their data and event together.
export function activityStatement(user: StaffUser, event: ActivityInput, onlyIfChanged = false) {
  return getDb().insert(activityEvents).select(sql`SELECT
    ${crypto.randomUUID()}, ${user.memberId}, ${user.displayName}, ${event.action},
    ${event.targetType}, ${event.targetId}, ${event.targetName}, ${event.details},
    ${event.createdAt ?? new Date().toISOString()}
    WHERE ${onlyIfChanged ? sql`changes() > 0` : sql`1 = 1`}`);
}

export function activityRowsStatement(user: StaffUser, events: ActivityInput[]) {
  return getDb().insert(activityEvents).values(events.map(event => ({
    id: crypto.randomUUID(), actorId: user.memberId, actorName: user.displayName,
    action: event.action, targetType: event.targetType, targetId: event.targetId,
    targetName: event.targetName, details: event.details,
    createdAt: event.createdAt ?? new Date().toISOString(),
  })));
}

export function sessionLabel(slot: "morning" | "lunch") {
  return slot === "morning" ? "Morning break" : "Lunch break";
}
