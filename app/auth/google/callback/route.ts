import { and, eq, gt, lte } from "drizzle-orm";
import { getDb } from "@/db";
import { staffGoogleIdentities, staffOauthChallenges, staffSessions } from "@/db/schema";
import { getGoogleConfiguration } from "@/app/lib/school-auth-config";
import { exchangeGoogleCode, verifyGoogleIdToken } from "@/app/lib/google-oidc";
import { resolveVerifiedGoogleMember } from "@/app/lib/reflection-membership";
import { authCookie, hashAuthToken, OAUTH_BROWSER_COOKIE, randomAuthToken, readAuthCookie, STAFF_SESSION_COOKIE, STAFF_SESSION_SECONDS } from "@/app/lib/staff-auth";
import { authFailure, authRedirect } from "@/app/lib/auth-responses";
import { ApiError } from "@/app/lib/reflection-errors";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const config = getGoogleConfiguration();
  const clearFlow = [authCookie(OAUTH_BROWSER_COOKIE, "", 0, url.protocol === "https:")];
  if (!config) return authFailure("setup", 503, clearFlow);
  if (url.origin !== new URL(config.redirectUri).origin) return authFailure("failed", 403, clearFlow);
  const state = url.searchParams.get("state");
  const browser = readAuthCookie(request.headers.get("cookie"), OAUTH_BROWSER_COOKIE);
  if (!state || !/^[A-Za-z0-9_-]{32,128}$/.test(state) || !browser) return authFailure("expired", 400, clearFlow);
  try {
    const db = getDb();
    const now = Date.now();
    // Consume once before exchanging the code: replay and concurrent callbacks fail closed.
    const [challenge] = await db.delete(staffOauthChallenges).where(and(
      eq(staffOauthChallenges.stateHash, await hashAuthToken(state)),
      eq(staffOauthChallenges.browserHash, await hashAuthToken(browser)),
      gt(staffOauthChallenges.expiresAt, now),
    )).returning();
    if (!challenge) return authFailure("expired", 400, clearFlow);
    if (url.searchParams.has("error")) return authFailure("failed", 400, clearFlow);
    if (url.searchParams.has("iss") && !["https://accounts.google.com", "accounts.google.com"].includes(url.searchParams.get("iss")!)) return authFailure("failed", 400, clearFlow);
    const code = url.searchParams.get("code");
    if (!code) return authFailure("failed", 400, clearFlow);
    const token = await exchangeGoogleCode(config, code, challenge.codeVerifier);
    const profile = await verifyGoogleIdToken(config, token, challenge.nonce);
    const [linked] = await db.select().from(staffGoogleIdentities).where(eq(staffGoogleIdentities.subject, profile.subject)).limit(1);
    const member = await resolveVerifiedGoogleMember(profile, linked?.memberId);
    if (challenge.portal === "admin" && member.role !== "admin") return authFailure("role", 403, clearFlow);
    if (challenge.portal === "moderator" && member.role !== "admin" && member.role !== "moderator") return authFailure("role", 403, clearFlow);
    const [otherBinding] = await db.select().from(staffGoogleIdentities).where(eq(staffGoogleIdentities.memberId, member.memberId)).limit(1);
    if (otherBinding && otherBinding.subject !== profile.subject) return authFailure("account", 403, clearFlow);
    await db.insert(staffGoogleIdentities).values({ subject: profile.subject, memberId: member.memberId, email: profile.email, createdAt: now, lastAuthenticatedAt: now }).onConflictDoNothing();
    const [bound] = await db.select().from(staffGoogleIdentities).where(eq(staffGoogleIdentities.subject, profile.subject)).limit(1);
    if (!bound || bound.memberId !== member.memberId) return authFailure("account", 403, clearFlow);
    await db.update(staffGoogleIdentities).set({ email: profile.email, lastAuthenticatedAt: now }).where(eq(staffGoogleIdentities.subject, profile.subject));
    const previousSession = readAuthCookie(request.headers.get("cookie"), STAFF_SESSION_COOKIE);
    if (previousSession) await db.delete(staffSessions).where(eq(staffSessions.tokenHash, await hashAuthToken(previousSession)));
    await db.delete(staffSessions).where(lte(staffSessions.expiresAt, now));
    const session = randomAuthToken();
    await db.insert(staffSessions).values({ tokenHash: await hashAuthToken(session), memberId: member.memberId, googleSubject: profile.subject, createdAt: now, expiresAt: now + STAFF_SESSION_SECONDS * 1000 });
    return authRedirect(`/${member.role}`, [...clearFlow, authCookie(STAFF_SESSION_COOKIE, session, STAFF_SESSION_SECONDS, url.protocol === "https:")]);
  } catch (error) {
    return authFailure(error instanceof ApiError && error.status === 403 ? "account" : "failed", error instanceof ApiError && error.status === 403 ? 403 : 400, clearFlow);
  }
}
