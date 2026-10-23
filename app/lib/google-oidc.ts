import { base64url, createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export type GoogleConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  schoolDomain: string;
};

export type GoogleProfile = { subject: string; email: string; name: string };

type GoogleAuthorizationParameters = { state: string; nonce: string; codeVerifier: string };
type GoogleTokenTestOptions = { keyResolver: JWTVerifyGetKey };

const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_KEYS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"), {
  timeoutDuration: 5_000,
  cooldownDuration: 30_000,
  cacheMaxAge: 3_600_000,
});
const TOKEN_LIMIT = 16_384;
const RESPONSE_LIMIT = 65_536;
const SIGN_IN_ERROR = "Google sign-in could not be completed. Please try again.";
const VERIFICATION_ERROR = "Google sign-in could not be verified. Please try again.";

function validConfig(config: GoogleConfig): void {
  const printable = (value: unknown, limit: number) =>
    typeof value === "string" && value.length > 0 && value.length <= limit && /^[\x21-\x7e]+$/.test(value);
  if (!config || !printable(config.clientId, 512) || !printable(config.clientSecret, 2_048) ||
      !printable(config.redirectUri, 2_048) || typeof config.schoolDomain !== "string" ||
      config.schoolDomain.length > 253 ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(config.schoolDomain)) {
    throw new Error("School Google sign-in is not configured correctly.");
  }
  let redirect: URL;
  try { redirect = new URL(config.redirectUri); } catch {
    throw new Error("School Google sign-in is not configured correctly.");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname);
  if ((redirect.protocol !== "https:" && !(redirect.protocol === "http:" && loopback)) ||
      redirect.username || redirect.password || redirect.hash) {
    throw new Error("School Google sign-in is not configured correctly.");
  }
}

function validChallenge(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,512}$/.test(value);
}

function validVerifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}

function validToken(value: unknown): value is string {
  return typeof value === "string" && value.length <= TOKEN_LIMIT &&
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

/** The caller must keep state, nonce and verifier server-side, then consume them once. */
export async function googleAuthorizationUrl(
  config: GoogleConfig,
  parameters: GoogleAuthorizationParameters,
): Promise<string> {
  validConfig(config);
  if (!parameters || !validChallenge(parameters.state) || !validChallenge(parameters.nonce) || !validVerifier(parameters.codeVerifier)) {
    throw new Error(SIGN_IN_ERROR);
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parameters.codeVerifier));
  const url = new URL(AUTHORIZATION_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state: parameters.state,
    nonce: parameters.nonce,
    code_challenge: base64url.encode(new Uint8Array(digest)),
    code_challenge_method: "S256",
    hd: config.schoolDomain,
    prompt: "select_account",
  }).toString();
  return url.toString();
}

async function boundedResponseText(response: Response): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > RESPONSE_LIMIT)) {
    await response.body?.cancel();
    throw new Error(SIGN_IN_ERROR);
  }
  if (!response.body) throw new Error(SIGN_IN_ERROR);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > RESPONSE_LIMIT) {
        await reader.cancel();
        throw new Error(SIGN_IN_ERROR);
      }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let position = 0;
  for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** Returns only the ID token; access and refresh tokens are never retained. */
export async function exchangeGoogleCode(config: GoogleConfig, code: string, codeVerifier: string): Promise<string> {
  validConfig(config);
  if (typeof code !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(code) || !validVerifier(codeVerifier)) {
    throw new Error(SIGN_IN_ERROR);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        grant_type: "authorization_code",
        code,
        code_verifier: codeVerifier,
      }),
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(SIGN_IN_ERROR); }
    const result: unknown = JSON.parse(await boundedResponseText(response));
    if (!result || typeof result !== "object" || Array.isArray(result) ||
        !("id_token" in result) || !validToken(result.id_token)) throw new Error(SIGN_IN_ERROR);
    return result.id_token;
  } catch {
    // Provider responses and exceptions can contain codes, tokens or profile data.
    throw new Error(SIGN_IN_ERROR);
  } finally { clearTimeout(timeout); }
}

/** Production accepts only Google's fixed JWKS. Key injection is gated to unit tests. */
export async function verifyGoogleIdToken(
  config: GoogleConfig,
  idToken: string,
  expectedNonce: string,
  testOptions?: GoogleTokenTestOptions,
): Promise<GoogleProfile> {
  validConfig(config);
  try {
    if (!validToken(idToken) || !validChallenge(expectedNonce)) throw new Error(VERIFICATION_ERROR);
    if (testOptions && (typeof process === "undefined" || process.env.NODE_ENV !== "test" ||
        typeof testOptions.keyResolver !== "function")) throw new Error(VERIFICATION_ERROR);
    const { payload } = await jwtVerify(idToken, testOptions?.keyResolver ?? GOOGLE_KEYS, {
      algorithms: ["RS256"],
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: config.clientId,
      requiredClaims: ["iss", "aud", "exp", "iat", "sub", "nonce"],
      maxTokenAge: "10m",
      clockTolerance: 30,
    });
    if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) ||
        payload.exp! <= payload.iat! || payload.nonce !== expectedNonce ||
        payload.hd !== config.schoolDomain || payload.email_verified !== true ||
        (payload.azp !== undefined && payload.azp !== config.clientId) ||
        (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== config.clientId) ||
        typeof payload.sub !== "string" || !/^[\x21-\x7e]{1,255}$/.test(payload.sub) ||
        typeof payload.email !== "string" || payload.email.length > 254 ||
        !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+$/i.test(payload.email) ||
        payload.email.slice(payload.email.lastIndexOf("@") + 1).toLowerCase() !== config.schoolDomain) {
      throw new Error(VERIFICATION_ERROR);
    }
    const email = payload.email.toLowerCase();
    const fallbackName = email.slice(0, 120);
    let name = fallbackName;
    if (payload.name !== undefined) {
      if (typeof payload.name !== "string" || payload.name.length > 512 || /[\u0000-\u001f\u007f]/.test(payload.name)) {
        throw new Error(VERIFICATION_ERROR);
      }
      name = payload.name.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, 120) || fallbackName;
    }
    return { subject: payload.sub, email, name };
  } catch {
    throw new Error(VERIFICATION_ERROR);
  }
}
