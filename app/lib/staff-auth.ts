import { and, eq, gt, isNull } from "drizzle-orm";
import { headers } from "next/headers";
import type { ChatGPTUser } from "../chatgpt-auth";
import { getDb } from "@/db";
import { appUsers, staffGoogleIdentities, staffSessions } from "@/db/schema";

export type StaffIdentity = ChatGPTUser & { authSource: "google" | "chatgpt"; memberId?: string };
export const STAFF_SESSION_COOKIE = "lac_staff_session";
export const OAUTH_BROWSER_COOKIE = "lac_google_flow";
export const STAFF_SESSION_SECONDS = 10 * 60 * 60;
// Vercel accepts only school sessions created by the verified Google callback.
export function allowsPreviewIdentity(): boolean { return false; }

export function readAuthCookie(cookieHeader: string | null, name: string): string | null {
  const values = (cookieHeader || "").split(";").map(value => value.trim()).filter(value => value.startsWith(`${name}=`));
  if (values.length !== 1) return null;
  const value = values[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{32,128}$/.test(value) ? value : null;
}

export function randomAuthToken(bytes = 48): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes)))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function hashAuthToken(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function authCookie(name: string, value: string, seconds: number, secure: boolean): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${secure ? "; Secure" : ""}`;
}

export async function getStaffIdentity(): Promise<StaffIdentity | null> {
  const requestHeaders = await headers();
  const cookieHeader = requestHeaders.get("cookie");
  const sessionToken = readAuthCookie(cookieHeader, STAFF_SESSION_COOKIE);
  if (sessionToken) {
    const [session] = await getDb().select({
      memberId: staffSessions.memberId,
      subject: staffGoogleIdentities.subject,
      email: staffGoogleIdentities.email,
      name: appUsers.name,
    }).from(staffSessions)
      .innerJoin(staffGoogleIdentities, and(eq(staffSessions.googleSubject, staffGoogleIdentities.subject), eq(staffSessions.memberId, staffGoogleIdentities.memberId)))
      .innerJoin(appUsers, eq(appUsers.id, staffSessions.memberId))
      .where(and(eq(staffSessions.tokenHash, await hashAuthToken(sessionToken)), gt(staffSessions.expiresAt, Date.now()), eq(appUsers.status, "active"), isNull(appUsers.deletedAt))).limit(1);
    if (!session) return null;
    return { authSource: "google", memberId: session.memberId, userId: `google:${session.subject}`, email: session.email, displayName: session.name, fullName: session.name };
  }
  return null;
}
