import { getStaffIdentity } from "@/app/lib/staff-auth";
import { ValidationError } from "@/app/lib/reflection-validation";
import { ApiError } from "@/app/lib/reflection-errors";
import { requireStaffMembership, type StaffUser } from "@/app/lib/reflection-membership";
export { ApiError } from "@/app/lib/reflection-errors";

export function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff" },
  });
}

export async function authenticatedApi(
  request: Request,
  mutate: boolean,
  action: (user: StaffUser) => Promise<Response>,
): Promise<Response> {
  try {
    const user = await getStaffIdentity();
    if (!user) throw new ApiError(401, "Please sign in to access Reflection Room.");
    if (mutate) {
      const origin = request.headers.get("origin");
      if (origin && origin !== new URL(request.url).origin) {
        throw new ApiError(403, "This request must come from the Reflection Room site.");
      }
      const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      if (contentType !== "application/json") {
        throw new ApiError(415, "Please send this request as application/json.");
      }
    }
    return await action(await requireStaffMembership(user));
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.message }, error.status);
    if (error instanceof ValidationError) return json({ error: error.message }, 400);
    console.error("Reflection Room API failed", error);
    return json({ error: "Reflection Room could not save or load your changes. Please try again." }, 500);
  }
}

export async function readJson(request: Request): Promise<unknown> {
  const limit = 768 * 1024;
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) throw new ApiError(413, "This import is too large. Import up to 2,000 students at a time.");
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > limit) throw new ApiError(413, "This import is too large. Import up to 2,000 students at a time.");
  try {
    return JSON.parse(body);
  } catch {
    throw new ApiError(400, "The request contains invalid JSON.");
  }
}
