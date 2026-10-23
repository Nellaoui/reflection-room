import { eq } from "drizzle-orm";
import type { ChatGPTUser } from "@/app/chatgpt-auth";
import { getDb } from "@/db";
import { appUsers } from "@/db/schema";
import { normalizedEmail, type StaffRole } from "@/app/lib/reflection-validation";
import { allowsPreviewIdentity, type StaffIdentity } from "@/app/lib/staff-auth";

export type StaffPortal = "admin" | "teacher" | "moderator";
export type PortalAccess =
  | { allowed: true; role: StaffRole; memberId: string }
  | { allowed: false; reason: "anonymous" | "membership" | "disabled" | "wrong-role" };

// This route guard reads membership only. Portal selection never creates an
// account, binds an identity, or changes its stored role or status.
export async function getPortalAccess(identity: StaffIdentity | ChatGPTUser | null, portal: StaffPortal): Promise<PortalAccess> {
  if (!identity) return { allowed: false, reason: "anonymous" };
  const db = getDb();
  const isGoogle = "authSource" in identity && identity.authSource === "google";
  if (!isGoogle && !allowsPreviewIdentity()) return { allowed: false, reason: "membership" };
  if (isGoogle && !identity.memberId) return { allowed: false, reason: "membership" };
  let [member] = await db.select().from(appUsers).where(isGoogle ? eq(appUsers.id, identity.memberId!) : eq(appUsers.linkedUserId, identity.userId)).limit(1);
  if (!member && !isGoogle) {
    [member] = await db.select().from(appUsers).where(eq(appUsers.email, normalizedEmail(identity.email))).limit(1);
  }
  if (!member || (!isGoogle && member.linkedUserId && member.linkedUserId !== identity.userId)) {
    return { allowed: false, reason: "membership" };
  }
  if (member.status !== "active" || member.deletedAt) return { allowed: false, reason: "disabled" };
  if ((portal === "admin" && member.role !== "admin") || (portal === "moderator" && member.role === "teacher")) {
    return { allowed: false, reason: "wrong-role" };
  }
  return { allowed: true, role: member.role, memberId: member.id };
}
