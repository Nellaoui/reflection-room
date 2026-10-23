import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as jose from "jose";
import { createTestDatabase } from "./libsql-test-db.mjs";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const origin = "https://reflection.example.edu";
const profile = { subject: "123456789012345678901", email: "test.teacher@elitelac.com", name: "Verified Test Teacher" };
const previewIdentity = { userId: "preview-test-id", email: "preview@example.invalid", displayName: "Preview Test Identity", fullName: null };

// Real route, cookie, hashing, configuration, membership and Drizzle code executes
// against isolated SQLite through the actual libSQL driver. Google exchange/token verification are the boundary
// substituted here; the provider's cryptographic verification has its own tests.
async function harness({ nodeEnv = "production", configured = true } = {}) {
  const state = {
    headers: new Headers(), previewCalls: 0, exchanges: [], verifications: [],
    exchangeGate: null, profile: { ...profile }, sql: [],
    env: configured ? {
      NODE_ENV: nodeEnv,
      GOOGLE_CLIENT_ID: "test-web-client.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "test-client-secret-value",
      GOOGLE_REDIRECT_URI: `${origin}/auth/google/callback`,
    } : { NODE_ENV: nodeEnv },
  };
  const { sqlite, db, close } = await createTestDatabase({ beforeQuery: query => state.sql.push(query) });
  const modules = new Map();
  function load(relativePath) {
    const absolutePath = path.join(projectRoot, relativePath.endsWith(".ts") ? relativePath : `${relativePath}.ts`);
    if (modules.has(absolutePath)) return modules.get(absolutePath).exports;
    const loadedModule = { exports: {} }; modules.set(absolutePath, loadedModule);
    const source = readFileSync(absolutePath, "utf8");
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: absolutePath,
    }).outputText;
    function localRequire(specifier) {
      if (specifier === "@/db") return { getDb: () => db };
      if (specifier === "cloudflare:workers") throw new Error("Node auth must not import the Cloudflare runtime");
      if (specifier === "next/headers") return { headers: async () => state.headers };
      if (specifier === "jose") return jose;
      if (["@/app/chatgpt-auth", "../chatgpt-auth"].includes(specifier)) return {
        getChatGPTUser: async () => { state.previewCalls++; throw new Error("Native preview identity must never be read on Vercel"); },
      };
      if (specifier === "@/app/lib/google-oidc") return {
        ...load("app/lib/google-oidc"),
        exchangeGoogleCode: async (config, code, verifier) => {
          state.exchanges.push({ config, code, verifier });
          if (state.exchangeGate) await state.exchangeGate;
          return "verified-provider-token-fixture";
        },
        verifyGoogleIdToken: async (config, token, nonce) => {
          state.verifications.push({ config, token, nonce });
          return state.profile;
        },
      };
      if (specifier.startsWith("@/")) return load(specifier.slice(2));
      if (specifier.startsWith(".")) return load(path.relative(projectRoot, path.resolve(path.dirname(absolutePath), specifier)));
      return require(specifier);
    }
    new Function("require", "module", "exports", "process", compiled)(localRequire, loadedModule, loadedModule.exports, { env: state.env });
    return loadedModule.exports;
  }
  async function call(route, { query = "", method = "GET", cookie, headers = {}, base = origin } = {}) {
    const request = new Request(`${base}/${route}${query}`, { method, headers: { ...headers, ...(cookie ? { cookie } : {}) } });
    state.headers = request.headers;
    return load(`app/${route}/route`)[method](request);
  }
  const auth = load("app/lib/staff-auth");
  async function identity(cookie, extraHeaders = {}) {
    state.headers = new Headers({ ...extraHeaders, ...(cookie === undefined ? {} : { cookie }) });
    return auth.getStaffIdentity();
  }
  function member(role = "teacher", id = "test-member", email = profile.email) {
    sqlite.prepare("INSERT INTO app_users(id,email,name,role,status,created_at) VALUES(?,?,?,?,?,?)")
      .run(id, email, "Approved Test Staff", role, "active", new Date().toISOString());
    return id;
  }
  async function start(portal, cookie) {
    const response = await call("auth/google", { query: portal === undefined ? "" : `?portal=${portal}`, cookie });
    assert.equal(response.status, 303);
    const url = new URL(response.headers.get("location"));
    return { response, state: url.searchParams.get("state"), nonce: url.searchParams.get("nonce"), browser: cookieValue(response, auth.OAUTH_BROWSER_COOKIE) };
  }
  const callback = (flow, extra = {}) => call("auth/google/callback", {
    query: `?state=${encodeURIComponent(flow.state)}&code=test-provider-code`,
    cookie: `${auth.OAUTH_BROWSER_COOKIE}=${flow.browser}`, ...extra,
  });
  return { sqlite, close, state, load, call, auth, identity, member, start, callback };
}

function cookieValue(response, name) {
  const value = response.headers.getSetCookie().find(cookie => cookie.startsWith(`${name}=`));
  assert.ok(value, `Expected ${name} cookie`);
  return value.slice(name.length + 1).split(";")[0];
}

test("the common Google entry persists hashed bindings and a backwards-compatible teacher flow", async () => {
  const h = await harness();
  try {
    const flow = await h.start();
    const challenge = h.sqlite.prepare("SELECT * FROM staff_oauth_challenges").get();
    assert.equal(challenge.state_hash, await h.auth.hashAuthToken(flow.state));
    assert.equal(challenge.browser_hash, await h.auth.hashAuthToken(flow.browser));
    assert.notEqual(challenge.state_hash, flow.state);
    assert.notEqual(challenge.browser_hash, flow.browser);
    assert.equal(challenge.nonce, flow.nonce);
    assert.equal(challenge.portal, "teacher");
    assert.ok(challenge.expires_at - challenge.created_at === 600_000);
    const destination = new URL(flow.response.headers.get("location"));
    assert.equal(destination.searchParams.has("code_verifier"), false);
    assert.equal(destination.searchParams.has("client_secret"), false);
    const cookie = flow.response.headers.getSetCookie()[0];
    assert.match(cookie, /; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/);
    assert.equal(flow.response.headers.get("cache-control"), "private, no-store");
    assert.equal(flow.response.headers.get("referrer-policy"), "no-referrer");
  } finally { h.close(); }
});

test("common Google sign-in lands in the actual stored staff role without selecting a portal", async () => {
  for (const role of ["teacher", "admin", "moderator"]) {
    const h = await harness();
    try {
      h.member(role);
      const flow = await h.start();
      assert.equal(h.sqlite.prepare("SELECT portal FROM staff_oauth_challenges").get().portal, "teacher");
      const response = await h.callback(flow);
      assert.equal(response.status, 303);
      assert.equal(response.headers.get("location"), `/${role}`);
      const session = cookieValue(response, h.auth.STAFF_SESSION_COOKIE);
      const identity = await h.identity(`${h.auth.STAFF_SESSION_COOKIE}=${session}`);
      const admitted = await h.load("app/lib/reflection-membership").requireStaffMembership(identity);
      assert.equal(admitted.role, role);
      assert.equal(h.sqlite.prepare("SELECT role FROM app_users").get().role, role);
    } finally { h.close(); }
  }
});

test("legacy portal selection cannot change membership or elevate a teacher", async () => {
  const h = await harness();
  try {
    h.member("teacher");
    h.state.profile = { ...profile, role: "admin", name: "Claimed Administrator" };
    const denied = await h.callback(await h.start("admin"));
    assert.equal(denied.status, 403);
    assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM staff_sessions").get().count, 0);
    const admitted = await h.callback(await h.start());
    assert.equal(admitted.status, 303);
    assert.equal(admitted.headers.get("location"), "/teacher");
    assert.equal(h.sqlite.prepare("SELECT role FROM app_users").get().role, "teacher");
  } finally { h.close(); }
  const admin = await harness();
  try {
    admin.member("admin");
    assert.equal((await admin.callback(await admin.start("teacher"))).headers.get("location"), "/admin");
    assert.equal((await admin.callback(await admin.start("admin"))).headers.get("location"), "/admin");
  } finally { admin.close(); }
});

test("moderator Google sign-in uses the stored role and explicit moderator flows reject teachers", async () => {
  for (const [role, portal, expected] of [
    ["moderator", "moderator", 303], ["moderator", "teacher", 303], ["moderator", "admin", 403],
    ["teacher", "moderator", 403], ["admin", "moderator", 303],
  ]) {
    const h = await harness();
    try {
      h.member(role);
      const response = await h.callback(await h.start(portal));
      assert.equal(response.status, expected, `${role} ${portal}`);
      assert.equal(h.sqlite.prepare("SELECT role FROM app_users").get().role, role);
      if (expected === 303) assert.equal(response.headers.get("location"), `/${role}`);
      else {
        assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM staff_sessions").get().n, 0);
        assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM staff_google_identities").get().n, 0);
      }
    } finally { h.close(); }
  }
});

test("callback rejects state/browser mismatch, missing cookies and expired flows before Google exchange", async () => {
  const h = await harness();
  try {
    h.member(); const flow = await h.start();
    const badRequests = [
      { query: `?state=${"x".repeat(64)}&code=test`, cookie: `${h.auth.OAUTH_BROWSER_COOKIE}=${flow.browser}` },
      { cookie: `${h.auth.OAUTH_BROWSER_COOKIE}=${"x".repeat(64)}` },
      { cookie: "" },
      { cookie: `${h.auth.OAUTH_BROWSER_COOKIE}=invalid` },
      { cookie: `${h.auth.OAUTH_BROWSER_COOKIE}=${flow.browser}; ${h.auth.OAUTH_BROWSER_COOKIE}=${flow.browser}` },
      { query: "?state=short&code=test" },
    ];
    for (const request of badRequests) {
      const response = await h.callback(flow, request);
      assert.equal(response.status, 400);
      assert.equal(h.state.exchanges.length, 0);
      assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM staff_oauth_challenges").get().count, 1);
    }
    h.sqlite.prepare("UPDATE staff_oauth_challenges SET expires_at = ?").run(Date.now() - 1);
    assert.equal((await h.callback(flow)).status, 400);
    assert.equal(h.state.exchanges.length, 0);
    assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM staff_sessions").get().count, 0);
  } finally { h.close(); }
});

test("callback consumes its exact flow once and binds verifier, nonce, staff profile and opaque session", async () => {
  const h = await harness();
  try {
    h.member(); const flow = await h.start();
    const challenge = h.sqlite.prepare("SELECT * FROM staff_oauth_challenges").get();
    const response = await h.callback(flow);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/teacher");
    assert.equal(h.state.exchanges.length, 1);
    assert.equal(h.state.exchanges[0].verifier, challenge.code_verifier);
    assert.equal(h.state.verifications[0].nonce, challenge.nonce);
    assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM staff_oauth_challenges").get().count, 0);
    const rawSession = cookieValue(response, h.auth.STAFF_SESSION_COOKIE);
    const savedSession = h.sqlite.prepare("SELECT * FROM staff_sessions").get();
    assert.equal(savedSession.token_hash, await h.auth.hashAuthToken(rawSession));
    assert.notEqual(savedSession.token_hash, rawSession);
    assert.equal(savedSession.member_id, "test-member");
    assert.equal(savedSession.google_subject, profile.subject);
    assert.equal(savedSession.expires_at - savedSession.created_at, h.auth.STAFF_SESSION_SECONDS * 1000);
    assert.equal((await h.identity(`${h.auth.STAFF_SESSION_COOKIE}=${rawSession}`)).displayName, "Approved Test Staff");
    assert.equal(h.state.previewCalls, 0);
    assert.match(response.headers.getSetCookie().find(value => value.startsWith(`${h.auth.STAFF_SESSION_COOKIE}=`)), /HttpOnly; SameSite=Lax; Max-Age=36000; Secure$/);
    assert.equal((await h.callback(flow)).status, 400);
    assert.equal(h.state.exchanges.length, 1);
    assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM staff_sessions").get().count, 1);
    const consume = h.state.sql.find(query => /^delete from "staff_oauth_challenges".*returning/i.test(query));
    assert.ok(consume, "The production flow is consumed with DELETE RETURNING.");
  } finally { h.close(); }
});

test("concurrent callbacks consume the challenge only once before either can establish a session", async () => {
  const h = await harness();
  try {
    h.member(); const flow = await h.start();
    let release; h.state.exchangeGate = new Promise(resolve => { release = resolve; });
    const first = h.callback(flow);
    const second = h.callback(flow);
    // The queued exchange is deliberately held after atomic challenge consumption.
    const results = Promise.all([first, second]);
    setImmediate(() => release());
    assert.deepEqual((await results).map(response => response.status).sort(), [303, 400]);
    assert.equal(h.state.exchanges.length, 1);
    assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM staff_sessions").get().count, 1);
  } finally { h.close(); }
});

test("provider denial, wrong response issuer and missing code consume state without exchanging", async () => {
  const h = await harness();
  try {
    h.member();
    for (const suffix of ["&error=access_denied", "&iss=https%3A%2F%2Fevil.invalid", ""]) {
      const flow = await h.start();
      const query = `?state=${flow.state}${suffix === "" ? "" : "&code=test"}${suffix}`;
      const response = await h.callback(flow, { query });
      assert.equal(response.status, 400);
      assert.equal(h.state.exchanges.length, 0);
      assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM staff_oauth_challenges").get().count, 0);
      assert.equal((await h.callback(flow)).status, 400);
    }
  } finally { h.close(); }
});

test("start and callback reject wrong origins; start also rejects cross-site initiation and invalid portals", async () => {
  const h = await harness();
  try {
    for (const options of [
      { headers: { origin: "https://evil.invalid" } },
      { headers: { "sec-fetch-site": "cross-site" } },
      { base: "https://evil.invalid" },
    ]) assert.equal((await h.call("auth/google", { query: "?portal=teacher", ...options })).status, 403);
    for (const query of ["?portal=superuser", "?portal=", "?portal=administrator"]) {
      assert.equal((await h.call("auth/google", { query })).status, 400);
    }
    assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM staff_oauth_challenges").get().count, 0);
    const flow = await h.start();
    assert.equal((await h.callback(flow, { base: "https://evil.invalid" })).status, 403);
    assert.equal(h.state.exchanges.length, 0);
  } finally { h.close(); }
});

test("logout rejects cross-origin requests then revokes only the caller's hashed session and flow", async () => {
  const h = await harness();
  try {
    h.member(); const signedIn = await h.callback(await h.start());
    const session = cookieValue(signedIn, h.auth.STAFF_SESSION_COOKIE);
    const otherSession = h.auth.randomAuthToken();
    const otherHash = await h.auth.hashAuthToken(otherSession);
    h.sqlite.prepare("INSERT INTO staff_sessions(token_hash,member_id,google_subject,created_at,expires_at) VALUES(?,?,?,?,?)")
      .run(otherHash, "test-member", profile.subject, Date.now(), Date.now() + 60_000);
    const flow = await h.start();
    const cookie = `${h.auth.STAFF_SESSION_COOKIE}=${session}; ${h.auth.OAUTH_BROWSER_COOKIE}=${flow.browser}`;
    for (const headers of [{ origin: "https://evil.invalid" }, { "sec-fetch-site": "cross-site" }]) {
      const rejected = await h.call("auth/logout", { method: "POST", cookie, headers });
      assert.equal(rejected.status, 403);
      assert.equal(rejected.headers.getSetCookie().length, 0);
      assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM staff_sessions").get().count, 2);
    }
    const response = await h.call("auth/logout", { method: "POST", cookie, headers: { origin } });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/");
    assert.deepEqual(h.sqlite.prepare("SELECT token_hash FROM staff_sessions").all().map(row => row.token_hash), [otherHash]);
    assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM staff_oauth_challenges").get().count, 0);
    assert.equal(response.headers.getSetCookie().length, 2);
    for (const cleared of response.headers.getSetCookie()) assert.match(cleared, /; HttpOnly; SameSite=Lax; Max-Age=0; Secure$/);
    assert.equal(await h.identity(`${h.auth.STAFF_SESSION_COOKIE}=${session}`), null);
    assert.equal(h.state.previewCalls, 0);
  } finally { h.close(); }
});

test("a new login rotates an old opaque session rather than reusing it", async () => {
  const h = await harness();
  try {
    h.member(); const first = await h.callback(await h.start());
    const oldSession = cookieValue(first, h.auth.STAFF_SESSION_COOKIE);
    const flow = await h.start();
    const response = await h.callback(flow, { cookie: `${h.auth.OAUTH_BROWSER_COOKIE}=${flow.browser}; ${h.auth.STAFF_SESSION_COOKIE}=${oldSession}` });
    const newSession = cookieValue(response, h.auth.STAFF_SESSION_COOKIE);
    assert.notEqual(newSession, oldSession);
    assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM staff_sessions").get().count, 1);
    assert.equal(await h.identity(`${h.auth.STAFF_SESSION_COOKIE}=${oldSession}`), null);
    assert.equal((await h.identity(`${h.auth.STAFF_SESSION_COOKIE}=${newSession}`)).authSource, "google");
  } finally { h.close(); }
});

test("expired, unknown, malformed and duplicate school cookies remain anonymous in development", async () => {
  const h = await harness({ nodeEnv: "development" });
  try {
    h.member(); const signedIn = await h.callback(await h.start());
    const session = cookieValue(signedIn, h.auth.STAFF_SESSION_COOKIE);
    h.sqlite.prepare("UPDATE staff_sessions SET expires_at = ?").run(Date.now() - 1);
    for (const cookie of [
      `${h.auth.STAFF_SESSION_COOKIE}=${session}`,
      `${h.auth.STAFF_SESSION_COOKIE}=${"u".repeat(64)}`,
      `${h.auth.STAFF_SESSION_COOKIE}=short`,
      `${h.auth.STAFF_SESSION_COOKIE}=`,
      `${h.auth.STAFF_SESSION_COOKIE}=${"s".repeat(129)}`,
      `${h.auth.STAFF_SESSION_COOKIE}=percent%2Fencoded`,
      `${h.auth.STAFF_SESSION_COOKIE}=${session}; ${h.auth.STAFF_SESSION_COOKIE}=${session}`,
    ]) assert.equal(await h.identity(cookie), null);
    assert.equal(h.state.previewCalls, 0);
    assert.equal(await h.identity(), null);
    assert.equal(h.state.previewCalls, 0);
    assert.equal((await h.call("auth/logout", { method: "POST", headers: { origin } })).headers.get("location"), "/");
  } finally { h.close(); }
});

test("a Google session requires the stored subject/member binding", async () => {
  const h = await harness();
  try {
    assert.equal(await h.identity(), null); assert.equal(h.state.previewCalls, 0);
    h.member(); const signedIn = await h.callback(await h.start());
    const session = cookieValue(signedIn, h.auth.STAFF_SESSION_COOKIE);
    h.member("teacher", "other-member", "other.teacher@elitelac.com");
    h.sqlite.prepare("UPDATE staff_sessions SET member_id = ?").run("other-member");
    assert.equal(await h.identity(`${h.auth.STAFF_SESSION_COOKIE}=${session}`), null);
    assert.equal(h.state.previewCalls, 0);
  } finally { h.close(); }
});

test("Vercel never trusts native identity headers or permits preview membership in any Node environment", async () => {
  for (const nodeEnv of ["development", "production", "test"]) {
    const h = await harness({ nodeEnv });
    try {
      assert.equal(h.auth.allowsPreviewIdentity(), false);
      const forgedHeaders = {
        "oai-authenticated-user-id": previewIdentity.userId,
        "oai-authenticated-user-email": previewIdentity.email,
        "oai-authenticated-user-full-name": "Forged administrator",
      };
      assert.equal(await h.identity(undefined, forgedHeaders), null);
      assert.equal(await h.identity("__sites_local_auth=1", forgedHeaders), null);
      assert.equal(h.state.previewCalls, 0);
      const denied = await h.load("app/lib/reflection-api").authenticatedApi(new Request(`${origin}/api/data`), false, () => {
        throw new Error("Anonymous API action must not run");
      });
      assert.equal(denied.status, 401);
      await assert.rejects(h.load("app/lib/reflection-membership").requireStaffMembership(previewIdentity), error => error.status === 403);
      assert.deepEqual(await h.load("app/lib/portal-access").getPortalAccess(previewIdentity, "admin"), { allowed: false, reason: "membership" });
      assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM app_users").get().count, 0);
      assert.equal(h.state.sql.length, 0);
    } finally { h.close(); }
  }
});

test("an unlisted verified school Google account signs in as a teacher only", async () => {
  for (const portal of ["teacher", "admin"]) {
    const h = await harness();
    try {
      h.state.profile = { ...profile, email: "unlisted.staff@elitelac.com" };
      const response = await h.callback(await h.start(portal));
      const member = h.sqlite.prepare("SELECT role, status FROM app_users WHERE email = 'unlisted.staff@elitelac.com'").get();
      assert.deepEqual({ ...member }, { role: "teacher", status: "active" });
      assert.equal(response.status, portal === "teacher" ? 303 : 403);
      if (portal === "teacher") assert.equal(new URL(response.headers.get("location"), "https://reflection.example").pathname, "/teacher");
      assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM staff_sessions").get().count, portal === "teacher" ? 1 : 0);
    } finally { h.close(); }
  }
});

test("disabled and wrong-portal Google members cannot establish school sessions", async () => {
  for (const scenario of ["disabled", "wrong-portal"]) {
    const h = await harness();
    try {
      h.member();
      if (scenario === "disabled") h.sqlite.prepare("UPDATE app_users SET status='disabled'").run();
      const response = await h.callback(await h.start(scenario === "wrong-portal" ? "admin" : "teacher"));
      assert.equal(response.status, 403);
      assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM staff_sessions").get().count, 0);
      assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM staff_google_identities").get().count, 0);
      assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM staff_oauth_challenges").get().count, 0);
    } finally { h.close(); }
  }
});

test("a different Google subject cannot take over an already linked staff email", async () => {
  const h = await harness();
  try {
    h.member(); assert.equal((await h.callback(await h.start())).status, 303);
    h.state.profile = { ...profile, subject: "different-google-account-subject" };
    assert.equal((await h.callback(await h.start())).status, 403);
    assert.deepEqual(h.sqlite.prepare("SELECT subject FROM staff_google_identities").all().map(row => row.subject), [profile.subject]);
    assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM staff_sessions").get().count, 1);
  } finally { h.close(); }
});

test("disabling staff denies a still-valid Google session at the membership boundary", async () => {
  const h = await harness();
  try {
    h.member(); const response = await h.callback(await h.start());
    const session = cookieValue(response, h.auth.STAFF_SESSION_COOKIE);
    const cachedIdentity = await h.identity(`${h.auth.STAFF_SESSION_COOKIE}=${session}`);
    assert.ok(cachedIdentity);
    h.sqlite.prepare("UPDATE app_users SET status='disabled'").run();
    const identity = await h.identity(`${h.auth.STAFF_SESSION_COOKIE}=${session}`);
    assert.equal(identity, null);
    await assert.rejects(h.load("app/lib/reflection-membership").requireStaffMembership(cachedIdentity), error => error.status === 403);
    assert.equal(h.state.previewCalls, 0);
  } finally { h.close(); }
});

test("missing or invalid school Google configuration fails closed without challenges or exchange", async () => {
  const h = await harness({ configured: false });
  try {
    assert.equal(h.load("app/lib/school-auth-config").getGoogleConfiguration(), null);
    assert.equal((await h.call("auth/google", { query: "?portal=teacher" })).status, 503);
    assert.equal((await h.call("auth/google/callback", { query: `?state=${"s".repeat(64)}&code=test`, cookie: `${h.auth.OAUTH_BROWSER_COOKIE}=${"b".repeat(64)}` })).status, 503);
    assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM staff_oauth_challenges").get().count, 0);
    assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM staff_sessions").get().count, 0);
    assert.equal(h.state.exchanges.length, 0);
    const valid = {
      GOOGLE_CLIENT_ID: "test-web-client.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "test-client-secret-value",
      GOOGLE_REDIRECT_URI: `${origin}/auth/google/callback`,
    };
    for (const change of [
      { GOOGLE_CLIENT_ID: "untrusted-client.invalid" }, { GOOGLE_CLIENT_SECRET: "short" },
      { GOOGLE_REDIRECT_URI: "http://reflection.example.edu/auth/google/callback" },
      { GOOGLE_REDIRECT_URI: "http://127.0.0.1:5173/auth/google/callback" },
      { GOOGLE_REDIRECT_URI: `${origin}/auth/google/callback?unsafe=query` },
      { GOOGLE_REDIRECT_URI: `${origin}/wrong-callback` },
    ]) {
      Object.assign(h.state.env, valid, change);
      assert.equal(h.load("app/lib/school-auth-config").getGoogleConfiguration(), null);
      assert.equal((await h.call("auth/google", { query: "?portal=teacher" })).status, 503);
    }
    assert.equal(h.state.exchanges.length, 0);
  } finally { h.close(); }
});

test("Google configuration reads Node server environment and only permits HTTP callbacks on local development", async () => {
  for (const nodeEnv of ["development", "production", "test"]) {
    const h = await harness({ nodeEnv });
    try {
      const config = h.load("app/lib/school-auth-config");
      h.state.env.GOOGLE_CLIENT_ID = ` ${h.state.env.GOOGLE_CLIENT_ID} `;
      h.state.env.GOOGLE_CLIENT_SECRET = ` ${h.state.env.GOOGLE_CLIENT_SECRET} `;
      assert.deepEqual(config.getGoogleConfiguration(), {
        clientId: "test-web-client.apps.googleusercontent.com",
        clientSecret: "test-client-secret-value",
        redirectUri: `${origin}/auth/google/callback`,
        schoolDomain: "elitelac.com",
      });
      for (const hostname of ["localhost", "127.0.0.1", "[::1]"]) {
        h.state.env.GOOGLE_REDIRECT_URI = `http://${hostname}:3000/auth/google/callback`;
        assert.equal(Boolean(config.getGoogleConfiguration()), nodeEnv === "development");
      }
      for (const callback of [
        "http://reflection.example.edu/auth/google/callback",
        "https://user:password@reflection.example.edu/auth/google/callback",
        `${origin}/auth/google/callback?query=1`,
        `${origin}/auth/google/callback#fragment`,
        `${origin}/auth/google/callback/`,
      ]) {
        h.state.env.GOOGLE_REDIRECT_URI = callback;
        assert.equal(config.getGoogleConfiguration(), null);
      }
      delete h.state.env.GOOGLE_CLIENT_SECRET;
      assert.equal(config.getGoogleConfiguration(), null);
      assert.equal(h.auth.allowsPreviewIdentity(), false);
    } finally { h.close(); }
  }
});

test("deleted membership remains blocked even if a stale session survives or its status is accidentally reactivated", async () => {
  const h = await harness();
  try {
    h.member();
    const response = await h.callback(await h.start());
    const cookie = `${h.auth.STAFF_SESSION_COOKIE}=${cookieValue(response, h.auth.STAFF_SESSION_COOKIE)}`;
    const cachedIdentity = await h.identity(cookie);
    assert.ok(cachedIdentity);
    // Simulate an old/in-flight session and a status-only update from an older
    // client. The tombstone itself must still prevent every access boundary.
    h.sqlite.prepare("UPDATE app_users SET deleted_at=?, status='active'").run(new Date().toISOString());
    assert.equal(await h.identity(cookie), null);
    await assert.rejects(h.load("app/lib/reflection-membership").requireStaffMembership(cachedIdentity), error => error.status === 403);
    assert.deepEqual(await h.load("app/lib/portal-access").getPortalAccess(cachedIdentity, "admin"), { allowed: false, reason: "disabled" });
    assert.equal((await h.callback(await h.start())).status, 403);
    assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM staff_sessions").get().n, 1);
  } finally { h.close(); }
});
