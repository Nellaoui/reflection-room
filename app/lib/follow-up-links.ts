import { and, eq, inArray, sql, type SQLWrapper } from "drizzle-orm";
import type { getDb } from "@/db";
import { activityEvents, reflectionAssignments } from "@/db/schema";

export const automaticFollowUpAction = "reflection.auto_rescheduled";
export const automaticExtraFollowUpAction = "reflection.auto_extra";

export function automaticExtraSourceId(details: SQLWrapper) {
  return sql<string | null>`CASE WHEN json_valid(${details}) THEN json_extract(${details}, '$.sourceId') END`;
}

const extraSourceFromEvent = automaticExtraSourceId(sql`event.details`);

export function activeExtraFollowUpExists(sourceId: string | SQLWrapper) {
  return sql`EXISTS (
    SELECT 1 FROM activity_events AS event
    JOIN reflection_assignments AS extra ON extra.id = event.target_id
    WHERE event.target_type = 'reflection' AND event.action = ${automaticExtraFollowUpAction}
      AND extra.cancelled_at IS NULL AND ${extraSourceFromEvent} = ${sourceId}
  )`;
}

export function automaticFollowUpEvents(db: Pick<ReturnType<typeof getDb>, "select">) {
  // Group by assignment so the history reads each audit event once without
  // ever returning duplicate register rows.
  return db.select({
    targetId: activityEvents.targetId,
    sourceId: sql<string | null>`MAX(CASE WHEN ${activityEvents.action} = ${automaticExtraFollowUpAction}
      THEN ${automaticExtraSourceId(activityEvents.details)} END)`.as("source_id"),
  }).from(activityEvents).where(and(
    eq(activityEvents.targetType, "reflection"),
    inArray(activityEvents.action, [automaticFollowUpAction, automaticExtraFollowUpAction]),
  )).groupBy(activityEvents.targetId).as("automatic_follow_up_events");
}

export function effectiveFollowUpSourceId(events: ReturnType<typeof automaticFollowUpEvents>) {
  return sql<string | null>`COALESCE(${reflectionAssignments.rescheduledFromId}, ${events.sourceId})`;
}

export function followUpsBySource<T extends { id: string; date: string; rescheduledFromId: string | null }>(assignments: readonly T[]) {
  const bySource = new Map<string, T[]>();
  for (const assignment of assignments) {
    if (!assignment.rescheduledFromId) continue;
    const followUps = bySource.get(assignment.rescheduledFromId) ?? [];
    followUps.push(assignment);
    bySource.set(assignment.rescheduledFromId, followUps);
  }
  for (const followUps of bySource.values()) {
    followUps.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  }
  return bySource;
}
