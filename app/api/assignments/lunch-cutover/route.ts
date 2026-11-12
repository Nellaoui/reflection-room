import { getDb } from "@/db";
import { ApiError, authenticatedApi, json, readJson } from "@/app/lib/reflection-api";
import { requireAdmin } from "@/app/lib/reflection-membership";
import { applyLunchCutover, previewLunchCutover } from "@/app/lib/lunch-cutover";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return authenticatedApi(request, false, async user => {
    requireAdmin(user);
    return json(await previewLunchCutover(getDb()));
  });
}

export async function POST(request: Request) {
  return authenticatedApi(request, true, async user => {
    requireAdmin(user);
    const body = await readJson(request) as { planId?: unknown } | null;
    if (typeof body?.planId !== "string" || !/^[a-f0-9]{64}$/.test(body.planId)) {
      throw new ApiError(400, "Review the proposed moves before applying them.");
    }
    return json(await applyLunchCutover(getDb(), user, body.planId));
  });
}
