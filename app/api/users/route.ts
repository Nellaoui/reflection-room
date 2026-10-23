import { asc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { appUsers } from "@/db/schema";
import { ApiError, authenticatedApi, json, readJson } from "@/app/lib/reflection-api";
import { isUniqueConstraintError } from "@/app/lib/reflection-errors";
import { publicUserFields, requireAdmin } from "@/app/lib/reflection-membership";
import { userCreateInput } from "@/app/lib/reflection-validation";
import { SCHOOL_DOMAIN } from "@/app/lib/school-settings";
import { activityStatement } from "@/app/lib/reflection-activity";

export async function GET(request: Request) {
  return authenticatedApi(request, false, async (user) => {
    requireAdmin(user);
    return json({ users: await getDb().select(publicUserFields).from(appUsers).where(isNull(appUsers.deletedAt)).orderBy(asc(appUsers.name)) });
  });
}

export async function POST(request: Request) {
  return authenticatedApi(request, true, async (user) => {
    requireAdmin(user);
    const input = userCreateInput(await readJson(request));
    if (input.email.split("@")[1] !== SCHOOL_DOMAIN) throw new ApiError(400, `Use an @${SCHOOL_DOMAIN} school email address.`);
    const db = getDb();
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    try {
      const [[created]] = await db.batch([db.insert(appUsers).values({
        ...input,
        id,
        status: "active",
        createdAt,
      }).returning(publicUserFields), activityStatement(user, {
        action: "staff.created", targetType: "staff", targetId: id,
        targetName: input.name, details: `Added ${input.role} account`, createdAt,
      })]);
      return json({ ok: true, user: created });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const [existing] = await db.select({ deletedAt: appUsers.deletedAt }).from(appUsers).where(eq(appUsers.email, input.email)).limit(1);
        if (existing?.deletedAt) throw new ApiError(409, "This email belongs to a deleted staff account. Contact your school administrator to review access.");
        throw new ApiError(409, "This email already has a staff account. Update the existing account instead.");
      }
      throw error;
    }
  });
}
