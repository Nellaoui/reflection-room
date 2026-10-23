import { eq, lte } from "drizzle-orm";
import { getDb } from "@/db";
import { staffOauthChallenges } from "@/db/schema";
import { getGoogleConfiguration } from "@/app/lib/school-auth-config";
import { googleAuthorizationUrl } from "@/app/lib/google-oidc";
import { authCookie, hashAuthToken, OAUTH_BROWSER_COOKIE, randomAuthToken, readAuthCookie } from "@/app/lib/staff-auth";
import { authFailure, authRedirect } from "@/app/lib/auth-responses";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const config = getGoogleConfiguration();
  if (!config) return authFailure("setup", 503);
  if (url.origin !== new URL(config.redirectUri).origin || request.headers.get("sec-fetch-site") === "cross-site" || (request.headers.get("origin") && request.headers.get("origin") !== url.origin)) return authFailure("failed", 403);
  // The shared sign-in entry retains the legacy teacher value in stored flows.
  // Actual membership determines the landing page after Google verification.
  const portal = url.searchParams.get("portal") ?? "teacher";
  if (portal !== "admin" && portal !== "teacher" && portal !== "moderator") return authFailure("failed", 400);
  try {
    const db = getDb();
    const now = Date.now();
    const previousBrowser = readAuthCookie(request.headers.get("cookie"), OAUTH_BROWSER_COOKIE);
    if (previousBrowser) await db.delete(staffOauthChallenges).where(eq(staffOauthChallenges.browserHash, await hashAuthToken(previousBrowser)));
    await db.delete(staffOauthChallenges).where(lte(staffOauthChallenges.expiresAt, now));
    const state = randomAuthToken();
    const browser = randomAuthToken();
    const nonce = randomAuthToken();
    const codeVerifier = randomAuthToken(64);
    const destination = await googleAuthorizationUrl(config, { state, nonce, codeVerifier });
    await db.insert(staffOauthChallenges).values({ stateHash: await hashAuthToken(state), browserHash: await hashAuthToken(browser), nonce, codeVerifier, portal, createdAt: now, expiresAt: now + 10 * 60_000 });
    return authRedirect(destination, [authCookie(OAUTH_BROWSER_COOKIE, browser, 600, url.protocol === "https:")]);
  } catch { return authFailure("failed", 503); }
}
