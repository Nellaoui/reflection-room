import { desc } from "drizzle-orm";
import { getDb } from "@/db";
import { activityEvents } from "@/db/schema";
import { authenticatedApi, json } from "@/app/lib/reflection-api";
import { requireAdmin } from "@/app/lib/reflection-membership";
import { automaticExtraFollowUpAction } from "@/app/lib/follow-up-links";

export const dynamic = "force-dynamic";

function extraFollowUpSummary(details: string) {
  try {
    const payload = JSON.parse(details) as { summary?: unknown } | null;
    if (typeof payload?.summary === "string") return payload.summary;
  } catch {
    // Keep the activity entry readable if its saved details cannot be decoded.
  }
  return "An extra follow-up was booked automatically.";
}

export async function GET(request: Request) {
  return authenticatedApi(request, false, async (user) => {
    requireAdmin(user);
    const limit = 300;
    const events = await getDb().select().from(activityEvents)
      .orderBy(desc(activityEvents.createdAt), desc(activityEvents.id)).limit(limit);
    return json({
      events: events.map(event => event.action === automaticExtraFollowUpAction
        ? { ...event, details: extraFollowUpSummary(event.details) }
        : event),
      limit,
    });
  });
}
