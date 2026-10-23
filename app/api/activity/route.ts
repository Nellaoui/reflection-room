import { desc } from "drizzle-orm";
import { getDb } from "@/db";
import { activityEvents } from "@/db/schema";
import { authenticatedApi, json } from "@/app/lib/reflection-api";
import { requireAdmin } from "@/app/lib/reflection-membership";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return authenticatedApi(request, false, async (user) => {
    requireAdmin(user);
    const limit = 300;
    const events = await getDb().select().from(activityEvents)
      .orderBy(desc(activityEvents.createdAt), desc(activityEvents.id)).limit(limit);
    return json({ events, limit });
  });
}
