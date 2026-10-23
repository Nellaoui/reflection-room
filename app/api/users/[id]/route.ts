import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { appUsers, staffSessions } from "@/db/schema";
import { ApiError, authenticatedApi, json, readJson } from "@/app/lib/reflection-api";
import { publicUserFields, requireAdmin } from "@/app/lib/reflection-membership";
import { userPatchInput, validId } from "@/app/lib/reflection-validation";
import { activityStatement } from "@/app/lib/reflection-activity";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  return authenticatedApi(request, true, async (user) => {
    requireAdmin(user);
    const id = validId((await context.params).id);
    const patch = userPatchInput(await readJson(request));
    if (id === user.memberId && patch.status === "disabled") {
      throw new ApiError(409, "You cannot disable your own account.");
    }
    if (id === user.memberId && patch.role !== undefined && patch.role !== "admin") {
      throw new ApiError(409, "You cannot remove your own administrator role.");
    }
    const nextRole = patch.role ?? appUsers.role;
    const nextStatus = patch.status ?? appUsers.status;
    const db = getDb();
    // Evaluated in the same serialized write as the update, so concurrent changes
    // cannot demote or disable the final active administrator.
    const [updatedRows] = await db.batch([db.update(appUsers).set(patch).where(and(
      eq(appUsers.id, id),
      isNull(appUsers.deletedAt),
      or(
        ne(appUsers.role, "admin"),
        ne(appUsers.status, "active"),
        sql`(${nextRole} = 'admin' AND ${nextStatus} = 'active')`,
        sql`(SELECT COUNT(*) FROM app_users WHERE role = 'admin' AND status = 'active' AND deleted_at IS NULL) > 1`,
      ),
    )).returning(publicUserFields), activityStatement(user, {
      action: "staff.updated", targetType: "staff", targetId: id,
      targetName: sql`(SELECT name FROM app_users WHERE id = ${id})`,
      details: `Updated ${Object.keys(patch).join(", ")}${patch.role ? ` · ${patch.role}` : ""}${patch.status ? ` · ${patch.status}` : ""}`,
    }, true), db.delete(staffSessions).where(and(
      eq(staffSessions.memberId, id),
      sql`EXISTS (SELECT 1 FROM app_users WHERE id = ${id} AND (status = 'disabled' OR deleted_at IS NOT NULL))`,
    ))]);
    const updated = updatedRows[0];
    if (!updated) {
      const [exists] = await db.select({ id: appUsers.id }).from(appUsers).where(and(eq(appUsers.id, id), isNull(appUsers.deletedAt))).limit(1);
      if (!exists) throw new ApiError(404, "This staff account could not be found. Refresh the staff list.");
      throw new ApiError(409, "At least one active administrator must remain.");
    }
    return json({ ok: true, user: updated });
  });
}

export async function DELETE(request: Request, context: RouteContext) {
  return authenticatedApi(request, true, async (user) => {
    requireAdmin(user);
    const id = validId((await context.params).id);
    if (id === user.memberId) throw new ApiError(409, "You cannot delete your own account.");
    const db = getDb();
    const now = new Date().toISOString();
    // Keep the identity as a tombstone for historic attribution. The count is
    // checked by the serialized UPDATE, including when two admins act at once.
    const [deletedRows] = await db.batch([db.update(appUsers).set({ status: "disabled", deletedAt: now }).where(and(
      eq(appUsers.id, id), isNull(appUsers.deletedAt),
      or(ne(appUsers.role, "admin"), ne(appUsers.status, "active"),
        sql`(SELECT COUNT(*) FROM app_users WHERE role = 'admin' AND status = 'active' AND deleted_at IS NULL) > 1`),
    )).returning({ id: appUsers.id }), activityStatement(user, {
      action: "staff.deleted", targetType: "staff", targetId: id,
      targetName: sql`(SELECT name FROM app_users WHERE id = ${id})`,
      details: "Deleted staff account · sign-in access removed", createdAt: now,
    }, true), db.delete(staffSessions).where(and(
      eq(staffSessions.memberId, id),
      sql`EXISTS (SELECT 1 FROM app_users WHERE id = ${id} AND deleted_at IS NOT NULL)`,
    ))]);
    if (!deletedRows.length) {
      const [existing] = await db.select({ id: appUsers.id }).from(appUsers).where(and(eq(appUsers.id, id), isNull(appUsers.deletedAt))).limit(1);
      if (!existing) throw new ApiError(404, "This staff account could not be found. Refresh the staff list.");
      throw new ApiError(409, "At least one active administrator must remain.");
    }
    return json({ ok: true });
  });
}
