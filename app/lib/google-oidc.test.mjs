import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test, { after } from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, UnsecuredJWT } from "jose";
import * as jose from "jose";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const compiled = ts.transpileModule(readFileSync(new URL("./google-oidc.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = { exports: {} };
// Run the production adapter and real jose verifier. Only key transport is local.
new Function("require", "module", "exports", compiled)(
  (name) => name === "jose" ? jose : require(name), loaded, loaded.exports,
);
const { googleAuthorizationUrl, exchangeGoogleCode, verifyGoogleIdToken } = loaded.exports;
const previousMode = process.env.NODE_ENV;
process.env.NODE_ENV = "test";
after(() => { if (previousMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousMode; });

const config = {
  clientId: "test-web-client.apps.googleusercontent.com",
  clientSecret: "test-client-secret",
  redirectUri: "https://reflection.example.edu/auth/google/callback",
  schoolDomain: "elitelac.com",
};
const nonce = "test_nonce_with_sufficient_random_length";
const state = "test_state_with_sufficient_random_length";
const codeVerifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
const otherKeys = await generateKeyPair("RS256");
const publicJwk = { ...await exportJWK(publicKey), kid: "local-google-test-key", alg: "RS256", use: "sig" };
const keyResolver = createLocalJWKSet({ keys: [publicJwk] });
const testOptions = { keyResolver };
const sign = (payload, key = privateKey, algorithm = "RS256") => new SignJWT(payload)
  .setProtectedHeader({ alg: algorithm, kid: publicJwk.kid }).sign(key);
function claims(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "https://accounts.google.com", aud: config.clientId, sub: "123456789012345678901",
    iat: now, exp: now + 300, nonce, hd: config.schoolDomain,
    email: "teacher@elitelac.com", email_verified: true, name: "Test Teacher", ...overrides,
  };
}
async function rejected(payload, options = testOptions) {
  await assert.rejects(verifyGoogleIdToken(config, await sign(payload), nonce, options), {
    message: "Google sign-in could not be verified. Please try again.",
  });
}

test("authorization uses Google's endpoint, minimum scopes, nonce, hosted-domain hint and S256 PKCE", async () => {
  const url = new URL(await googleAuthorizationUrl(config, { state, nonce, codeVerifier }));
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("scope"), "openid email profile");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("state"), state);
  assert.equal(url.searchParams.get("nonce"), nonce);
  assert.equal(url.searchParams.get("hd"), "elitelac.com");
  assert.equal(url.searchParams.get("prompt"), "select_account");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  assert.equal(url.searchParams.get("redirect_uri"), config.redirectUri);
  assert.equal(url.searchParams.has("client_secret"), false);
  assert.equal(url.searchParams.has("access_type"), false);
  assert.equal(url.searchParams.has("code_verifier"), false);
});

test("authorization rejects undersized, oversized and invalid binding values", async () => {
  for (const change of [
    { state: "short" }, { state: "a".repeat(513) }, { state: "contains whitespace value" },
    { nonce: "short" }, { nonce: "a".repeat(513) },
    { codeVerifier: "v".repeat(42) }, { codeVerifier: "v".repeat(129) }, { codeVerifier: "!".repeat(43) },
  ]) await assert.rejects(googleAuthorizationUrl(config, { state, nonce, codeVerifier, ...change }));
});

test("configuration rejects domain tricks, insecure remote callbacks and embedded credentials", async () => {
  for (const change of [
    { schoolDomain: "elitelac.com.evil.invalid/" }, { schoolDomain: "elitelac.com@evil.invalid" },
    { schoolDomain: "EliteLac.com" }, { schoolDomain: "elitelac.com." }, { clientId: "" },
    { clientSecret: "" }, { redirectUri: "http://reflection.example.edu/callback" },
    { redirectUri: "https://user:secret@reflection.example.edu/callback" },
    { redirectUri: "https://reflection.example.edu/callback#fragment" },
  ]) await assert.rejects(googleAuthorizationUrl({ ...config, ...change }, { state, nonce, codeVerifier }), {
    message: "School Google sign-in is not configured correctly.",
  });
  const local = new URL(await googleAuthorizationUrl({ ...config, redirectUri: "http://127.0.0.1:5173/auth/google/callback" }, { state, nonce, codeVerifier }));
  assert.equal(local.searchParams.get("redirect_uri"), "http://127.0.0.1:5173/auth/google/callback");
});

test("real RS256 verification accepts both Google issuers and returns a minimal profile", async () => {
  for (const issuer of ["https://accounts.google.com", "accounts.google.com"]) {
    const profile = await verifyGoogleIdToken(config, await sign(claims({ iss: issuer })), nonce, testOptions);
    assert.deepEqual(profile, { subject: "123456789012345678901", email: "teacher@elitelac.com", name: "Test Teacher" });
  }
  assert.deepEqual(await verifyGoogleIdToken(config, await sign(claims({ name: undefined })), nonce, testOptions), {
    subject: "123456789012345678901", email: "teacher@elitelac.com", name: "teacher@elitelac.com",
  });
});

test("all identity, time, nonce and school claims are required", async () => {
  for (const field of ["iss", "aud", "exp", "iat", "sub", "nonce", "hd", "email", "email_verified"]) {
    const payload = claims(); delete payload[field]; await rejected(payload);
  }
});

test("signed but invalid issuer, audience, time, nonce, domain and identity claims fail closed", async () => {
  const now = Math.floor(Date.now() / 1000);
  for (const change of [
    { iss: "https://evil.invalid" }, { aud: "another-client" }, { nonce: "different_nonce_with_sufficient_length" },
    { exp: now - 60, iat: now - 120 }, { iat: now - 700 }, { iat: now + 120, exp: now + 300 },
    { iat: now + 0.5 }, { exp: now + 300.5 }, { exp: now, iat: now },
    { hd: "other.elitelac.com" }, { hd: "elitelac.com.evil.invalid" }, { hd: "EliteLac.com" },
    { email: "teacher@elitelac.com.evil.invalid" }, { email: "teacher@other.elitelac.com" },
    { email: "teacher@elitelac.com\n" }, { email: "Teacher <teacher@elitelac.com>" },
    { email_verified: false }, { email_verified: "true" }, { azp: "another-client" }, { azp: null },
    { sub: "s".repeat(256) }, { sub: "non_ascii_é" }, { sub: "control\ncharacter" }, { sub: "" },
    { name: "contains\ncontrol" }, { name: { unsafe: true } }, { name: "n".repeat(513) },
  ]) await rejected(claims(change));
});

test("authorized presenter is checked and multiple audiences require the matching presenter", async () => {
  await rejected(claims({ aud: [config.clientId, "other-client"] }));
  const profile = await verifyGoogleIdToken(config, await sign(claims({ aud: [config.clientId, "other-client"], azp: config.clientId })), nonce, testOptions);
  assert.equal(profile.subject, "123456789012345678901");
  assert.equal((await verifyGoogleIdToken(config, await sign(claims({ azp: config.clientId })), nonce, testOptions)).email, "teacher@elitelac.com");
});

test("unsigned, HMAC, corrupted and wrong-signature tokens never pass", async () => {
  const valid = await sign(claims());
  const tokens = [
    new UnsecuredJWT(claims()).encode(),
    await sign(claims(), new Uint8Array(32), "HS256"),
    await sign(claims(), otherKeys.privateKey),
    `${valid.slice(0, -20)}${"A".repeat(20)}`,
  ];
  for (const token of tokens) await assert.rejects(verifyGoogleIdToken(config, token, nonce, testOptions), {
    message: "Google sign-in could not be verified. Please try again.",
  });
});

test("token bounds and nonce bounds are checked before key resolution", async () => {
  let calls = 0;
  const options = { keyResolver: async () => { calls++; return publicKey; } };
  for (const token of ["", "invalid-token", "a".repeat(16_385), "a.b.", "a.b.c\n"]) {
    await assert.rejects(verifyGoogleIdToken(config, token, nonce, options));
  }
  await assert.rejects(verifyGoogleIdToken(config, await sign(claims()), "short", options));
  assert.equal(calls, 0);
});

test("test key injection is rejected outside NODE_ENV=test", async () => {
  process.env.NODE_ENV = "production";
  try {
    await assert.rejects(verifyGoogleIdToken(config, await sign(claims()), nonce, testOptions), {
      message: "Google sign-in could not be verified. Please try again.",
    });
  } finally { process.env.NODE_ENV = "test"; }
});

test("code exchange submits the verifier to the fixed endpoint and returns only the ID token", async (t) => {
  const idToken = await sign(claims());
  let request;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    request = { url, init };
    return Response.json({ id_token: idToken, access_token: "discard-access-token", refresh_token: "discard-refresh-token" });
  });
  assert.equal(await exchangeGoogleCode(config, "test-authorization-code", codeVerifier), idToken);
  assert.equal(request.url, "https://oauth2.googleapis.com/token");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.redirect, "error");
  assert.equal(request.init.cache, "no-store");
  assert.equal(request.init.body.get("code_verifier"), codeVerifier);
  assert.equal(request.init.body.get("client_secret"), config.clientSecret);
  assert.equal(request.init.body.get("code"), "test-authorization-code");
  assert.equal(request.init.body.get("grant_type"), "authorization_code");
  assert.equal(request.init.body.get("redirect_uri"), config.redirectUri);
});

test("code exchange rejects input bounds before sending credentials", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("must not send"); });
  for (const code of ["", "c".repeat(4097), "code\nsecret", "code with spaces"]) {
    await assert.rejects(exchangeGoogleCode(config, code, codeVerifier));
  }
  await assert.rejects(exchangeGoogleCode(config, "valid-code", "v".repeat(42)));
  assert.equal(calls, 0);
});

test("provider failures, malformed responses and oversized bodies produce sanitized errors", async (t) => {
  const providerSecret = "private-provider-value@example.invalid";
  const responses = [
    () => { throw new Error(providerSecret); },
    () => Response.json({ error_description: providerSecret }, { status: 400 }),
    () => new Response("invalid JSON " + providerSecret),
    () => Response.json({ access_token: providerSecret }),
    () => Response.json({ id_token: "invalid" }),
    () => Response.json({ id_token: "a".repeat(16_385) }),
    () => new Response("x".repeat(65_537)),
    () => new Response("{}", { headers: { "content-length": "65537" } }),
  ];
  let next;
  t.mock.method(globalThis, "fetch", async () => next());
  for (const response of responses) {
    next = response;
    await assert.rejects(exchangeGoogleCode(config, "test-code", codeVerifier), (error) => {
      assert.equal(error.message, "Google sign-in could not be completed. Please try again.");
      assert.equal("cause" in error, false);
      assert.equal(error.message.includes(providerSecret), false);
      return true;
    });
  }
});
