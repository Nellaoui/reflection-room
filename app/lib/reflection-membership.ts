import { and, eq, isNull, sql } from "drizzle-orm";
import type { ChatGPTUser } from "@/app/chatgpt-auth";
import { getDb } from "@/db";
import { appUsers } from "@/db/schema";
import { ApiError } from "@/app/lib/reflection-errors";
import { normalizedEmail, type StaffRole } from "@/app/lib/reflection-validation";
import { allowsPreviewIdentity, type StaffIdentity } from "@/app/lib/staff-auth";
import { INITIAL_ADMIN_EMAIL, SCHOOL_DOMAIN } from "@/app/lib/school-auth-config";

export type StaffUser = ChatGPTUser & { authSource?: "google" | "chatgpt"; role: StaffRole; memberId: string };

export const publicUserFields = {
  id: appUsers.id,
  name: appUsers.name,
  email: appUsers.email,
  role: appUsers.role,
  status: appUsers.status,
  linked: sql<boolean>`CASE WHEN ${appUsers.linkedUserId} IS NULL THEN 0 ELSE 1 END`.mapWith(Boolean),
  createdAt: appUsers.createdAt,
  lastSeenAt: appUsers.lastSeenAt,
};

export async function requireStaffMembership(identity: StaffIdentity | ChatGPTUser): Promise<StaffUser> {
  if ("authSource" in identity && identity.authSource === "google") {
    if (!identity.memberId) throw new ApiError(403, "Your school account is not linked to an authorised staff profile.");
    schoolEmail(identity.email);
    const [member] = await getDb().select().from(appUsers).where(eq(appUsers.id, identity.memberId)).limit(1);
    if (!member) throw new ApiError(403, "Staff access is required. Contact your school administrator.");
    if (member.status !== "active" || member.deletedAt) throw new ApiError(403, "Your staff access has been disabled. Contact your school administrator.");
    return { ...identity, displayName: member.name, role: member.role, memberId: member.id };
  }
  if (!allowsPreviewIdentity()) throw new ApiError(403, "Sign in with your authorised school Google account.");
  return requirePreviewStaffMembership(identity);
}

async function requirePreviewStaffMembership(identity: ChatGPTUser): Promise<StaffUser> {
  const db = getDb();
  const email = normalizedEmail(identity.email);
  const now = new Date().toISOString();
  let [member] = await db.select().from(appUsers).where(eq(appUsers.linkedUserId, identity.userId)).limit(1);
  if (!member) {
    [member] = await db.select().from(appUsers).where(eq(appUsers.email, email)).limit(1);
  }

  if (!member) {
    // The site is owner-private at setup. A single atomic statement admits its first
    // authenticated owner; once any account exists, nobody can self-register.
    await db.run(sql`INSERT INTO app_users
      (id, email, name, role, status, linked_user_id, created_at, last_seen_at)
      SELECT ${crypto.randomUUID()}, ${email}, ${identity.displayName.slice(0, 120)}, 'admin', 'active', ${identity.userId}, ${now}, ${now}
      WHERE NOT EXISTS (SELECT 1 FROM app_users)
      ON CONFLICT DO NOTHING`);
    [member] = await db.select().from(appUsers).where(eq(appUsers.linkedUserId, identity.userId)).limit(1);
  }
  if (!member) throw new ApiError(403, "Staff access is required. Ask your school administrator to add your account.");
  if (member.status !== "active" || member.deletedAt) throw new ApiError(403, "Your staff access has been disabled. Contact your school administrator.");
  if (member.linkedUserId && member.linkedUserId !== identity.userId) {
    throw new ApiError(403, "This staff email is already linked to another sign-in account. Contact your school administrator.");
  }
  if (!member.linkedUserId) {
    const bound = await db.update(appUsers).set({ linkedUserId: identity.userId, lastSeenAt: now })
      .where(and(eq(appUsers.id, member.id), isNull(appUsers.linkedUserId), eq(appUsers.status, "active"), isNull(appUsers.deletedAt)))
      .returning();
    if (!bound.length) throw new ApiError(403, "Your staff account changed during sign-in. Please try again.");
    member = bound[0];
  } else {
    await db.update(appUsers).set({ lastSeenAt: now }).where(eq(appUsers.id, member.id));
  }
  return { ...identity, authSource: "chatgpt", displayName: member.name, role: member.role, memberId: member.id };
}

function schoolEmail(value: string): string {
  const email = normalizedEmail(value);
  if (email.slice(email.lastIndexOf("@") + 1) !== SCHOOL_DOMAIN.toLowerCase()) {
    throw new ApiError(403, "Use your authorised school Google Workspace account.");
  }
  return email;
}

// Call only after Google has verified the token, subject, school domain and
// email. Session/provider identity binding is owned by the OAuth callback.
export async function resolveVerifiedGoogleMember(
  profile: { subject: string; email: string; name: string },
  linkedMemberId?: string,
): Promise<StaffUser> {
  const email = schoolEmail(profile.email);
  if (!profile.subject) throw new ApiError(403, "The verified school identity is missing its subject.");
  const db = getDb();
  let [member] = linkedMemberId
    ? await db.select().from(appUsers).where(eq(appUsers.id, linkedMemberId)).limit(1)
    : await db.select().from(appUsers).where(eq(appUsers.email, email)).limit(1);
  if (!member && !linkedMemberId && email === INITIAL_ADMIN_EMAIL.toLowerCase()) {
    await db.insert(appUsers).values({
      id: crypto.randomUUID(), email,
      name: profile.name.trim().slice(0, 120) || email,
      role: "admin", status: "active", createdAt: new Date().toISOString(),
    }).onConflictDoNothing({ target: appUsers.email });
    [member] = await db.select().from(appUsers).where(eq(appUsers.email, email)).limit(1);
  }
  if (!member) throw new ApiError(403, "Your school account has not been added by an administrator.");
  if (member.status !== "active" || member.deletedAt) throw new ApiError(403, "Your staff access has been disabled. Contact your school administrator.");
  return {
    userId: `google:${profile.subject}`, email, displayName: member.name,
    fullName: profile.name, authSource: "google", role: member.role, memberId: member.id,
  };
}

export function requireAdmin(user: StaffUser): void {
  if (user.role !== "admin") throw new ApiError(403, "Only a school administrator can manage students and staff accounts.");
}

export function requireInsightsAccess(user: StaffUser): void {
  if (user.role !== "admin" && user.role !== "moderator") {
    throw new ApiError(403, "Student and teacher insights require administrator or moderator access.");
  }
}
