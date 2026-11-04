import { getDb } from "@/db";
import { authenticatedApi, json } from "@/app/lib/reflection-api";
import { requireAdmin } from "@/app/lib/reflection-membership";
import { weeklyReportPreview } from "@/app/lib/weekly-report-delivery";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return authenticatedApi(request, false, async user => {
    requireAdmin(user);
    return json(await weeklyReportPreview(getDb(), { previewOrigin: new URL(request.url).origin }));
  });
}
