import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { students } from "@/db/schema";
import { ApiError, authenticatedApi, json, readJson } from "@/app/lib/reflection-api";
import { isUniqueConstraintError } from "@/app/lib/reflection-errors";
import { requireAdmin } from "@/app/lib/reflection-membership";
import { makeRosterKey, studentPatchInput, validId } from "@/app/lib/reflection-validation";
import { activityStatement } from "@/app/lib/reflection-activity";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  return authenticatedApi(request, true, async (user) => {
    requireAdmin(user);
    const id = validId((await context.params).id);
    const patch = studentPatchInput(await readJson(request));
    const db = getDb();
    const [student] = await db.select().from(students).where(eq(students.id, id)).limit(1);
    if (!student) throw new ApiError(404, "This student could not be found. Refresh the directory.");
    const next = { ...student, ...patch };
    try {
      const now = new Date().toISOString();
      await db.batch([db.update(students).set({
        ...patch,
        rosterKey: makeRosterKey(next.name, next.grade, next.className, student.toddleId),
        updatedAt: now,
      }).where(eq(students.id, id)), activityStatement(user, {
        action: patch.active === false ? "student.archived" : "student.updated",
        targetType: "student", targetId: id,
        targetName: sql`(SELECT name FROM students WHERE id = ${id})`,
        details: patch.active === true ? "Restored to the active directory" : patch.active === false ? "Archived student · reflection history retained" : `Updated ${Object.keys(patch).map(key => key === "className" ? "class" : key).join(", ")}`,
        createdAt: now,
      }, true)]);
    } catch (error) {
      if (isUniqueConstraintError(error)) throw new ApiError(409, "A student with this name, grade, and class already exists.");
      throw error;
    }
    return json({ ok: true });
  });
}

export async function DELETE(request: Request, context: RouteContext) {
  return authenticatedApi(request, true, async (user) => {
    requireAdmin(user);
    const id = validId((await context.params).id);
    const db = getDb();
    const now = new Date().toISOString();
    const [result] = await db.batch([db.update(students).set({ active: false, updatedAt: now })
      .where(eq(students.id, id)).returning({ id: students.id }), activityStatement(user, {
        action: "student.archived", targetType: "student", targetId: id,
        targetName: sql`(SELECT name FROM students WHERE id = ${id})`,
        details: "Archived student · reflection history retained", createdAt: now,
      }, true)]);
    if (!result.length) throw new ApiError(404, "This student could not be found. Refresh the directory.");
    return json({ ok: true });
  });
}
