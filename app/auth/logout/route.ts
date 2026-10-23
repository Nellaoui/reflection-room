import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { staffOauthChallenges, staffSessions } from "@/db/schema";
import { authCookie, hashAuthToken, OAUTH_BROWSER_COOKIE, readAuthCookie, STAFF_SESSION_COOKIE } from "@/app/lib/staff-auth";
import { authFailure, authRedirect } from "@/app/lib/auth-responses";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const url = new URL(request.url);
  if ((request.headers.get("origin") && request.headers.get("origin") !== url.origin) || request.headers.get("sec-fetch-site") === "cross-site") return authFailure("failed", 403);
  const cookies = request.headers.get("cookie");
  const session = readAuthCookie(cookies, STAFF_SESSION_COOKIE);
  const browser = readAuthCookie(cookies, OAUTH_BROWSER_COOKIE);
  try {
    if (session) await getDb().delete(staffSessions).where(eq(staffSessions.tokenHash, await hashAuthToken(session)));
    if (browser) await getDb().delete(staffOauthChallenges).where(eq(staffOauthChallenges.browserHash, await hashAuthToken(browser)));
  } catch { return authFailure("failed", 503); }
  const cleared = [authCookie(STAFF_SESSION_COOKIE, "", 0, url.protocol === "https:"), authCookie(OAUTH_BROWSER_COOKIE, "", 0, url.protocol === "https:")];
  return authRedirect("/", cleared);
}
