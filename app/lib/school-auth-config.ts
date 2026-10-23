import { SCHOOL_DOMAIN } from "./school-settings";
import type { GoogleConfig } from "./google-oidc";

export { SCHOOL_DOMAIN };
export const INITIAL_ADMIN_EMAIL = "t-wiam-zahri@elitelac.com";

function setting(name: string): string {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

export function getGoogleConfiguration(): GoogleConfig | null {
  const clientId = setting("GOOGLE_CLIENT_ID");
  const clientSecret = setting("GOOGLE_CLIENT_SECRET");
  const redirectUri = setting("GOOGLE_REDIRECT_URI");
  if (!clientId || !clientSecret || !redirectUri) return null;
  if (clientId.length > 512 || !/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(clientId)) return null;
  if (!/^[\x21-\x7e]{10,2048}$/.test(clientSecret)) return null;
  try {
    const callback = new URL(redirectUri);
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(callback.hostname);
    if (callback.username || callback.password || callback.search || callback.hash || callback.pathname !== "/auth/google/callback") return null;
    if (callback.protocol !== "https:" && !(process.env.NODE_ENV === "development" && local && callback.protocol === "http:")) return null;
  } catch { return null; }
  return { clientId, clientSecret, redirectUri, schoolDomain: SCHOOL_DOMAIN };
}
