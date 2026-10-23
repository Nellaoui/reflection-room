import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const { renderToStaticMarkup } = require("react-dom/server");
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

// Load real server modules with only request, environment and database boundaries
// substituted. No Vite plugin or native identity provider exists in this runtime.
function nodeModules({ nodeEnv = "production", configured = false } = {}) {
  let requestHeaders = new Headers();
  const deletedTables = [];
  const modules = new Map();
  const env = { NODE_ENV: nodeEnv, ...(configured ? {
    GOOGLE_CLIENT_ID: "test-web-client.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "test-client-secret-value",
    GOOGLE_REDIRECT_URI: "https://reflection.example.edu/auth/google/callback",
  } : {}) };
  function load(relativePath) {
    const filename = path.resolve(projectRoot, relativePath);
    if (modules.has(filename)) return modules.get(filename).exports;
    const loadedModule = { exports: {} }; modules.set(filename, loadedModule);
    const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
      fileName: filename,
    }).outputText;
    const localRequire = specifier => {
      if (specifier.endsWith(".css")) return {};
      if (specifier === "cloudflare:workers" || specifier.includes("chatgpt-auth")) throw new Error("Native auth runtime must not be imported on Vercel");
      if (specifier === "@/db") return { getDb: () => ({ delete: table => ({ where: async () => { deletedTables.push(require("drizzle-orm").getTableName(table)); } }) }) };
      if (specifier === "next/headers") return { headers: async () => requestHeaders };
      if (specifier === "next/navigation") return { redirect: destination => { throw new Error(`Unexpected automatic redirect: ${destination}`); } };
      if (specifier.startsWith(".") || specifier.startsWith("@/")) {
        const candidate = specifier.startsWith("@/") ? path.resolve(projectRoot, specifier.slice(2)) : path.resolve(path.dirname(filename), specifier);
        for (const suffix of [".ts", ".tsx", ""]) {
          try { return load(path.relative(projectRoot, candidate + suffix)); } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
        }
      }
      return require(specifier);
    };
    new Function("require", "module", "exports", "process", compiled)(localRequire, loadedModule, loadedModule.exports, { env });
    return loadedModule.exports;
  }
  return { load, deletedTables, setHeaders: headers => { requestHeaders = new Headers(headers); } };
}

test("school logout is POST only, revokes session and flow, and returns to the Google gate", async () => {
  for (const nodeEnv of ["development", "production"]) {
    const modules = nodeModules({ nodeEnv });
    const route = modules.load("app/auth/logout/route.ts");
    assert.equal(route.GET, undefined);
    const cookie = `lac_staff_session=${"s".repeat(64)}; lac_google_flow=${"b".repeat(64)}`;
    const result = await route.POST(new Request("https://reflection.example.edu/auth/logout", {
      method: "POST", headers: { origin: "https://reflection.example.edu", cookie },
    }));
    assert.equal(result.status, 303);
    assert.equal(result.headers.get("location"), "/");
    assert.deepEqual(modules.deletedTables.sort(), ["staff_oauth_challenges", "staff_sessions"]);
    const cookies = result.headers.getSetCookie();
    assert.equal(cookies.length, 2);
    for (const cleared of cookies) assert.match(cleared, /HttpOnly; SameSite=Lax; Max-Age=0; Secure/);
    const marker = "PRIVATE_WORKSPACE_CHILDREN_MUST_NOT_RENDER";
    const html = renderToStaticMarkup(await modules.load("app/layout.tsx").default({ children: marker }));
    assert.equal(html.includes(marker), false);
    assert.equal((html.match(/Continue with Google/g) || []).length, 1);
    assert.match(html, /Google sign-in is being configured/);
    assert.doesNotMatch(html, /signin-with-chatgpt|signout-with-chatgpt|Local preview/);
  }
});

test("logout rejects cross-origin and cross-site submissions without clearing sessions", async () => {
  const modules = nodeModules();
  const route = modules.load("app/auth/logout/route.ts");
  for (const headers of [{ origin: "https://other.example" }, { "sec-fetch-site": "cross-site" }]) {
    const blocked = await route.POST(new Request("https://reflection.example.edu/auth/logout", {
      method: "POST", headers: { ...headers, cookie: `lac_staff_session=${"s".repeat(64)}` },
    }));
    assert.equal(blocked.status, 403);
    assert.equal(blocked.headers.get("set-cookie"), null);
    assert.deepEqual(modules.deletedTables, []);
  }
});

test("forged native identity headers cannot open the Vercel layout in development or production", async () => {
  for (const nodeEnv of ["development", "production"]) {
    const modules = nodeModules({ nodeEnv, configured: true });
    modules.setHeaders({
      "oai-authenticated-user-id": "forged-native-owner",
      "oai-authenticated-user-email": "forged@elitelac.com",
      cookie: "__sites_local_auth=1",
    });
    const marker = "PRIVATE_WORKSPACE_CHILDREN_MUST_NOT_RENDER";
    const html = renderToStaticMarkup(await modules.load("app/layout.tsx").default({ children: marker }));
    assert.equal(html.includes(marker), false);
    assert.equal((html.match(/href="\/auth\/google"/g) || []).length, 1);
    assert.doesNotMatch(html, /signin-with-chatgpt|signout-with-chatgpt|Local preview|Admin login|Teacher login/);
    assert.equal(modules.load("app/lib/staff-auth.ts").allowsPreviewIdentity(), false);
  }
});

test("signed-out staff see one common Google action and no role or native provider selection", () => {
  const modules = nodeModules();
  const panel = modules.load("app/components/SignInPanel.tsx").default;
  const ready = renderToStaticMarkup(panel({ googleReady: true, provider: "chatgpt", showPreviewSignIn: true }));
  assert.equal((ready.match(/Continue with Google/g) || []).length, 1);
  assert.equal((ready.match(/href="\/auth\/google"/g) || []).length, 1);
  assert.match(ready, /target="_top"/);
  assert.doesNotMatch(ready, /auth\/google\?portal=|Admin login|Teacher login|signin-with-chatgpt|Local preview/);
  const setup = renderToStaticMarkup(panel({ googleReady: false }));
  assert.equal((setup.match(/Continue with Google/g) || []).length, 1);
  assert.match(setup, /<button[^>]*disabled/);
  assert.match(setup, /Google sign-in is being configured/);
  assert.doesNotMatch(setup, /href="\/auth\/google"|signin-with-chatgpt/);
});
