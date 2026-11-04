import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTestDatabase } from "./libsql-test-db.mjs";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const { LibsqlError } = require("@libsql/client");
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const friday = new Date("2026-11-06T14:10:00.000Z");
const safeEnv = {
  WEEKLY_REPORT_ENABLED: "true", WEEKLY_REPORT_RECIPIENTS: "leader@elitelac.com,headteacher@elitelad.com",
  WEEKLY_REPORT_FROM: "Reflection Room <reports@elitelac.com>", WEEKLY_REPORT_APP_URL: "https://reflection.example.edu",
  RESEND_API_KEY: "fixture-key-not-a-real-provider-key", CRON_SECRET: "fixture-weekly-cron-secret-12345",
};

function moduleLoader(overrides = {}) {
  const modules = new Map();
  function load(relativePath) {
    const filename = path.join(projectRoot, relativePath.endsWith(".ts") ? relativePath : `${relativePath}.ts`);
    if (modules.has(filename)) return modules.get(filename).exports;
    const loaded = { exports: {} };
    modules.set(filename, loaded);
    const compiled = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: filename }).outputText;
    const localRequire = specifier => {
      if (Object.hasOwn(overrides, specifier)) return overrides[specifier];
      if (specifier.startsWith("@/")) return load(specifier.slice(2));
      return require(specifier);
    };
    new Function("require", "module", "exports", compiled)(localRequire, loaded, loaded.exports);
    return loaded.exports;
  }
  return load;
}

const pure = moduleLoader()('app/lib/weekly-report');
function row(id, studentId, date, status = "pending", extra = {}) {
  return { id, studentId, date, status, teacherId: "teacher-1", grade: "Year 7", className: "7A", reasonRecorded: true, ...extra };
}

test("weekly boundaries and Friday window use Casablanca, including Ramadan offset changes", () => {
  assert.equal(pure.reportWeek(new Date("2026-01-04T23:30:00Z")).start, "2026-01-05");
  assert.equal(pure.reportWeek(new Date("2026-01-04T23:30:00Z")).end, "2026-01-09");
  assert.equal(pure.reportWeek(new Date("2026-11-01T23:30:00Z")).start, "2026-10-26");
  assert.equal(pure.casablancaClock(new Date("2026-03-13T14:00:00Z")).hour, 14);
  assert.equal(pure.casablancaClock(new Date("2026-11-06T14:00:00Z")).hour, 14);
  assert.equal(pure.isWeeklyReportWindow(new Date("2026-03-13T14:00:00Z")), true);
  assert.equal(pure.isWeeklyReportWindow(new Date("2026-11-06T14:00:00Z")), true);
  assert.equal(pure.isWeeklyReportWindow(new Date("2026-11-06T16:00:00Z")), false);
  assert.equal(pure.isWeeklyReportWindow(new Date("2026-01-09T15:00:00Z")), false);
  assert.equal(pure.isWeeklyReportWindow(new Date("2026-11-05T14:00:00Z")), false);
  assert.throws(() => pure.reportWeek(new Date("invalid")));
});

test("behaviour insights distinguish referral days, separate follow-ups and do not turn pending into absent", () => {
  const rows = [
    row("a1", "student-a", "2026-11-02", "absent"),
    row("a2", "student-a", "2026-11-02", "present"),
    row("a3", "student-a", "2026-11-03", "pending", { teacherId: "teacher-2" }),
    row("b1", "student-b", "2026-11-04", "absent", { className: "7B", reasonRecorded: false }),
    row("b2", "student-b", "2026-11-04", "absent", { className: "7B" }),
    row("f1", "student-a", "2026-11-05", "present", { teacherId: "teacher-2", rescheduledFromId: "a1" }),
    row("f2", "student-b", "2026-11-09", "pending", { rescheduledFromId: "b1" }),
    row("cancelled-follow-up", "student-b", "2026-11-06", "pending", { rescheduledFromId: "b2", cancelledAt: "2026-11-04T09:00:00Z" }),
    row("cancelled", "student-c", "2026-11-04", "absent", { cancelledAt: "2026-11-04T09:00:00Z" }),
    row("previous-1", "student-p", "2026-10-26", "present"),
    row("previous-2", "student-p", "2026-10-27", "absent"),
    row("previous-follow-up", "student-p", "2026-10-28", "pending", { rescheduledFromId: "previous-2" }),
    row("weekend", "student-c", "2026-11-07", "absent"),
  ];
  rows.push({ ...rows[0], studentName: "Private Pupil", reason: "Private reason" });
  const report = pure.buildWeeklyReport(rows, { now: friday, appUrl: "https://reflection.example.edu" });
  assert.deepEqual(report.metrics, {
    initial: 5, followUps: 1, total: 6, students: 2, present: 2, absent: 3, pending: 1,
    missedAwaitingFollowUp: 1, studentsWithRepeatedReferralDays: 1, studentsWithRepeatedAbsences: 1,
    referringTeachers: 2, largestTeacherShare: 80, initialSessionsWithoutReason: 1,
  });
  assert.equal(report.patterns.classes[0].className, "7A");
  assert.equal(report.patterns.classes[0].initial, 3);
  assert.equal(report.patterns.previousWeek.initialChange, 3);
  assert.equal(report.patterns.previousWeek.absentChange, 2);
  assert.match(report.text, /two or more separate days/);
  assert.match(report.text, /Cross-check missed sessions with school attendance/);
  assert.match(report.text, /Private Pupil/);
  assert.doesNotMatch(JSON.stringify(report), /Private reason|student-a|teacher-1/);
  assert.equal(report.dashboardUrl, "https://reflection.example.edu/moderator");
});

test("empty weeks remain factual and contain no invented intervention or comparisons as percentages", () => {
  const report = pure.buildWeeklyReport([], { now: friday, appUrl: "http://127.0.0.1:5173" });
  assert.equal(report.metrics.total, 0);
  assert.equal(report.metrics.largestTeacherShare, null);
  assert.match(report.text, /No reflection sessions are recorded for this reporting week/);
  assert.equal(report.patterns.suggestedActions.length, 0);
  assert.equal(report.patterns.previousWeek.initialChange, 0);
  assert.throws(() => pure.buildWeeklyReport([], { now: friday, appUrl: "javascript:alert(1)" }));
});

test("named student tables include every weekly student, rank separate referral days first and escape HTML names", () => {
  const rows = Array.from({ length: 12 }, (_, index) => row(`session-${index}`, `pupil-${index}`, "2026-11-02", index === 10 ? "absent" : "present", { studentName: `Student ${index}`, teacherName: "Teacher One" }));
  rows.push(row("second-break-same-day", "pupil-10", "2026-11-02", "absent", { studentName: "Student 10" }));
  rows.push(row("separate-day", "pupil-11", "2026-11-03", "present", { studentName: "<img src=x onerror=alert(1)>", teacherName: "Teacher One" }));
  rows[11].studentName = "<img src=x onerror=alert(1)>";
  const report = pure.buildWeeklyReport(rows, { now: friday, appUrl: safeEnv.WEEKLY_REPORT_APP_URL });
  assert.equal(report.tables.studentCount, 12);
  assert.equal(report.tables.students.length, 12);
  assert.equal(report.tables.students[0].referralDays, 2);
  assert.equal(report.tables.students[1].name, "Student 10");
  assert.equal(report.tables.students[1].referralDays, 1);
  assert.equal(report.metrics.studentsWithRepeatedReferralDays, 1);
  assert.equal(report.metrics.studentsWithRepeatedAbsences, 1);
  assert.match(report.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(report.html, /<img src=x/);
  assert.equal(report.tables.teachers[0].students, 12);
  assert.match(report.html, /Teacher assignment overview/);
  assert.match(report.html, /Complete weekly list: 12 students with sessions this week/);
  assert.doesNotMatch(report.text, /up to 10/);
});

test("standalone email declares UTF-8 and uses singular grammar without changing counts", () => {
  const assignment = row("single-session", "pupil-1", "2026-11-02", "absent", { studentName: "Élève Exemple", teacherName: "François Example", reasonRecorded: false });
  const single = pure.buildWeeklyReport([assignment], { now: friday, appUrl: safeEnv.WEEKLY_REPORT_APP_URL });
  assert.match(single.html, /<head><meta charset="utf-8">/);
  assert.match(single.html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(single.html, /<title>Reflection Room — Weekly behaviour insights/);
  assert.match(single.html, /Élève Exemple/);
  assert.match(single.html, /François Example/);
  assert.match(single.text, /1 staff member assigned 1 initial session; 0 follow-ups were scheduled separately/);
  assert.match(single.text, /1 missed session still needs a follow-up/);
  assert.match(single.text, /1 initial session has no reason recorded/);
  assert.match(single.html, /Complete weekly list: 1 student with sessions/);
  const repeated = pure.buildWeeklyReport([
    assignment, row("another-day", "pupil-1", "2026-11-03", "absent"),
    row("follow-up", "pupil-1", "2026-11-04", "present", { rescheduledFromId: assignment.id }),
  ], { now: friday, appUrl: safeEnv.WEEKLY_REPORT_APP_URL });
  assert.match(repeated.text, /1 student had initial reflections scheduled on two or more separate days/);
  assert.match(repeated.text, /1 student missed two or more recorded sessions/);
  assert.match(repeated.text, /1 follow-up was scheduled separately/);
  assert.match(repeated.text, /check-ins for the 1 student with initial reflections/);
  assert.equal(repeated.metrics.initial, 2);
  assert.equal(repeated.metrics.followUps, 1);
  assert.doesNotMatch(single.text + repeated.text, /\b1 (students|initial sessions|missed sessions|follow-ups|staff members)\b/);
});

test("readiness is disabled by default, accepts explicitly configured external domains and never reveals secrets", () => {
  const settings = pure.weeklyReportReadiness(safeEnv);
  assert.equal(settings.ready, true);
  assert.deepEqual(settings.recipients, ["leader@elitelac.com", "headteacher@elitelad.com"]);
  assert.equal(pure.weeklyReportReadiness({ ...safeEnv, WEEKLY_REPORT_ENABLED: "TRUE" }).ready, false);
  assert.equal(pure.weeklyReportReadiness({}).enabled, false);
  assert.equal(pure.weeklyReportReadiness({ ...safeEnv, WEEKLY_REPORT_RECIPIENTS: "leader@elitelac.com,LEADER@elitelac.com" }).recipients.length, 1);
  assert.equal(pure.weeklyReportReadiness({ ...safeEnv, WEEKLY_REPORT_FROM: "Bad\r\nBcc: stranger@example.com" }).from, null);
  assert.equal(pure.weeklyReportReadiness({ ...safeEnv, WEEKLY_REPORT_APP_URL: "https://reflection.example.edu/?token=secret" }).appUrl, null);
  assert.deepEqual(pure.weeklyReportReadiness({ ...safeEnv, WEEKLY_REPORT_RECIPIENTS: "not-an-email" }).recipients, []);
  assert.doesNotMatch(JSON.stringify(settings), /fixture-key|fixture-weekly-cron/);
});

async function harness() {
  const state = { identity: { authSource: "google", memberId: "owner-member", userId: "google:owner", email: "owner@elitelac.com", displayName: "Owner", fullName: null }, beforeQuery: null };
  const transport = await createTestDatabase({ beforeQuery: (sql, args) => state.beforeQuery?.(sql, args) });
  const { db, sqlite } = transport;
  sqlite.prepare("INSERT INTO app_users(id,email,name,role,status,created_at) VALUES(?,?,?,?,?,?)").run("owner-member", "owner@elitelac.com", "Owner", "admin", "active", "2026-11-01");
  const load = moduleLoader({
    "@/db": { getDb: () => db },
    "@/app/lib/staff-auth": { getStaffIdentity: async () => state.identity, allowsPreviewIdentity: () => false },
    "@/app/lib/school-auth-config": { SCHOOL_DOMAIN: "elitelac.com", INITIAL_ADMIN_EMAIL: "owner@elitelac.com" },
  });
  const service = load("app/lib/weekly-report-delivery");
  function student(id = "pupil-a", className = "7A") {
    sqlite.prepare("INSERT INTO students(id,name,grade,class_name,roster_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(id, `Private ${id}`, "Year 7", className, id, "2026-11-01", "2026-11-01");
  }
  function assignment(id = "reflection-a", options = {}) {
    const value = { studentId: "pupil-a", date: "2026-11-02", slot: "morning", reason: "Private reason", status: "absent", author: "google:owner", rescheduledFromId: null, ...options };
    sqlite.prepare("INSERT INTO reflection_assignments(id,student_id,date,slot,reason,assigned_by,status,created_at,updated_at,created_by_user_id,updated_by_user_id,rescheduled_from_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, value.studentId, value.date, value.slot, value.reason, "Private staff name", value.status, "2026-11-01T10:00:00Z", "2026-11-01T10:00:00Z", value.author, value.author, value.rescheduledFromId);
  }
  async function call(route, headers = {}) {
    const response = await load(`app/api/${route}/route`).GET(new Request(`https://reflection.example.edu/api/${route}`, { headers }));
    return { status: response.status, headers: response.headers, data: await response.json() };
  }
  return { ...transport, state, load, service, student, assignment, call };
}

async function withEnvironment(values, action) {
  const keys = Object.keys(safeEnv);
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) { if (values[key] === undefined) delete process.env[key]; else process.env[key] = values[key]; }
    return await action();
  } finally { for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } }
}

test("report query attributes staff by identity, includes prior week comparisons and contains approved named tables but no reasons or provider identities", async () => {
  const h = await harness();
  try {
    h.student();
    h.sqlite.prepare("INSERT INTO app_users(id,email,name,role,status,linked_user_id,created_at) VALUES(?,?,?,?,?,?,?)").run("staff-1", "staff-1@elitelac.com", "Same staff name", "teacher", "active", "native:staff-1", "2026-11-01");
    h.sqlite.prepare("INSERT INTO app_users(id,email,name,role,status,created_at) VALUES(?,?,?,?,?,?)").run("staff-2", "staff-2@elitelac.com", "Same staff name", "teacher", "active", "2026-11-01");
    for (const [subject, memberId] of [["provider-1", "staff-1"], ["provider-2", "staff-2"]]) h.sqlite.prepare("INSERT INTO staff_google_identities VALUES(?,?,?,?,?)").run(subject, memberId, `${memberId}@elitelac.com`, 1, 1);
    h.assignment("a", { author: "google:provider-1" });
    h.assignment("b", { date: "2026-11-03", author: "native:staff-1", status: "present" });
    h.assignment("c", { date: "2026-11-04", author: "google:provider-2", status: "pending" });
    h.assignment("previous", { date: "2026-10-26", author: "native:staff-1", status: "present" });
    h.sqlite.prepare("UPDATE app_users SET status='disabled',deleted_at='2026-11-05' WHERE id='staff-2'").run();
    const report = await h.service.loadWeeklyReport(h.db, friday, safeEnv.WEEKLY_REPORT_APP_URL);
    assert.equal(report.metrics.referringTeachers, 2);
    assert.equal(report.metrics.largestTeacherShare, 67);
    assert.equal(report.metrics.studentsWithRepeatedReferralDays, 1);
    assert.equal(report.patterns.previousWeek.initialChange, 2);
    assert.match(report.text, /Private pupil-a/);
    assert.match(report.text, /Same staff name/);
    assert.equal(report.tables.teachers.length, 2);
    assert.doesNotMatch(JSON.stringify(report), /Private reason|provider-1|staff-1@/);
  } finally { h.close(); }
});

test("disabled or unconfigured sending and non-Friday times never create a delivery or call email provider", async () => {
  const h = await harness();
  try {
    const fetcher = async () => { throw new Error("Provider must not be called"); };
    assert.deepEqual(await h.service.dispatchWeeklyReport({ now: friday, env: {}, db: h.db, fetcher }), { status: "skipped", reason: "disabled" });
    assert.deepEqual(await h.service.dispatchWeeklyReport({ now: friday, env: { WEEKLY_REPORT_ENABLED: "true" }, db: h.db, fetcher }), { status: "skipped", reason: "setup_required" });
    assert.equal((await h.service.dispatchWeeklyReport({ now: new Date("2026-11-04T14:10:00Z"), env: safeEnv, db: h.db, fetcher })).reason, "outside_friday_afternoon");
    assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM weekly_report_deliveries").get().n, 0);
  } finally { h.close(); }
});

test("concurrent weekly invocations claim once and later invocations cannot send a duplicate", async () => {
  const h = await harness();
  try {
    h.student(); h.assignment();
    let calls = 0;
    let releaseProvider; let markStarted;
    const gate = new Promise(resolve => { releaseProvider = resolve; });
    const started = new Promise(resolve => { markStarted = resolve; });
    const fetcher = async (url, options) => {
      calls++; assert.equal(url, "https://api.resend.com/emails");
      assert.ok(options.headers["Idempotency-Key"].startsWith("reflection-room-weekly/"));
      assert.match(options.body, /Private pupil-a/);
      assert.doesNotMatch(options.body, /Private reason|google:owner/);
      markStarted(); await gate;
      return Response.json({ id: "provider-message-1" });
    };
    const first = h.service.dispatchWeeklyReport({ now: friday, env: safeEnv, db: h.db, fetcher });
    await started;
    const second = await h.service.dispatchWeeklyReport({ now: friday, env: safeEnv, db: h.db, fetcher });
    assert.deepEqual(second, { status: "skipped", reason: "in_progress" });
    releaseProvider(); assert.deepEqual(await first, { status: "sent" });
    assert.equal((await h.service.dispatchWeeklyReport({ now: friday, env: safeEnv, db: h.db, fetcher })).reason, "already_sent");
    assert.equal(calls, 1);
    assert.deepEqual({ ...h.sqlite.prepare("SELECT status,attempts,provider_message_id FROM weekly_report_deliveries").get() }, { status: "sent", attempts: 1, provider_message_id: "provider-message-1" });
  } finally { h.close(); }
});

test("known provider rejection can retry the frozen email with the same idempotency key", async () => {
  const h = await harness();
  try {
    h.student(); h.assignment();
    const requests = [];
    const fetcher = async (_url, options) => { requests.push(options); return requests.length === 1 ? Response.json({ message: "Private provider detail" }, { status: 429 }) : Response.json({ id: "provider-message-2" }); };
    assert.deepEqual(await h.service.dispatchWeeklyReport({ now: friday, env: safeEnv, db: h.db, fetcher }), { status: "retryable", reason: "provider_rejected" });
    h.assignment("new-session", { date: "2026-11-03", status: "present" });
    const retried = await h.service.dispatchWeeklyReport({ now: new Date(friday.getTime() + 60_000), env: safeEnv, db: h.db, fetcher });
    assert.equal(retried.status, "sent");
    assert.equal(requests[0].body, requests[1].body);
    assert.equal(requests[0].headers["Idempotency-Key"], requests[1].headers["Idempotency-Key"]);
    assert.equal(h.sqlite.prepare("SELECT attempts FROM weekly_report_deliveries").get().attempts, 2);
  } finally { h.close(); }
});

test("unknown outcomes retry within the provider window but old uncertain records require review", async () => {
  const h = await harness();
  try {
    h.student(); h.assignment();
    const requests = [];
    const fetcher = async (_url, options) => { requests.push(options); if (requests.length === 1) throw new Error("Network timeout with private details"); return Response.json({ id: "provider-message-3" }); };
    assert.equal((await h.service.dispatchWeeklyReport({ now: friday, env: safeEnv, db: h.db, fetcher })).status, "uncertain");
    assert.equal((await h.service.dispatchWeeklyReport({ now: new Date(friday.getTime() + 60_000), env: safeEnv, db: h.db, fetcher })).status, "sent");
    assert.equal(requests[0].body, requests[1].body);
    h.sqlite.prepare("UPDATE weekly_report_deliveries SET status='uncertain',created_at=?,claimed_at=?").run("2026-11-05T13:00:00Z", Date.parse("2026-11-05T13:00:00Z"));
    assert.deepEqual(await h.service.dispatchWeeklyReport({ now: friday, env: safeEnv, db: h.db, fetcher }), { status: "uncertain", reason: "provider_review_required" });
    assert.equal(requests.length, 2);
  } finally { h.close(); }
});

test("a changed recipient approval cannot reuse an old failed delivery", async () => {
  const h = await harness();
  try {
    h.student(); h.assignment();
    let calls = 0;
    const fetcher = async () => { calls++; return Response.json({}, { status: 403 }); };
    await h.service.dispatchWeeklyReport({ now: friday, env: safeEnv, db: h.db, fetcher });
    assert.equal((await h.service.dispatchWeeklyReport({ now: friday, env: { ...safeEnv, WEEKLY_REPORT_RECIPIENTS: "different@elitelac.com" }, db: h.db, fetcher })).reason, "delivery_configuration_changed");
    assert.equal(calls, 1);
    assert.match(h.sqlite.prepare("SELECT payload FROM weekly_report_deliveries").get().payload, /leader@elitelac.com/);
  } finally { h.close(); }
});

test("provider acceptance followed by a ledger failure does not claim success; stale recovery keeps the same frozen request", async () => {
  const h = await harness();
  try {
    h.student(); h.assignment();
    const requests = [];
    const fetcher = async (_url, options) => { requests.push(options); return Response.json({ id: "accepted-message" }); };
    h.state.beforeQuery = sql => { if (/^update "weekly_report_deliveries"/i.test(sql)) throw new Error("Ledger temporarily unavailable"); };
    assert.deepEqual(await h.service.dispatchWeeklyReport({ now: friday, env: safeEnv, db: h.db, fetcher }), { status: "uncertain", reason: "delivery_record_unavailable" });
    h.state.beforeQuery = null;
    assert.equal(h.sqlite.prepare("SELECT status FROM weekly_report_deliveries").get().status, "sending");
    assert.equal((await h.service.dispatchWeeklyReport({ now: new Date(friday.getTime() + 6 * 60_000), env: safeEnv, db: h.db, fetcher })).status, "sent");
    assert.equal(requests[0].body, requests[1].body);
    assert.equal(requests[0].headers["Idempotency-Key"], requests[1].headers["Idempotency-Key"]);
  } finally { h.close(); }
});

test("weekly preview is admin-only, private, includes approved named tables and never sends or creates a delivery", async () => {
  const h = await harness();
  try {
    h.student(); h.assignment();
    await withEnvironment(safeEnv, async () => {
      const owner = { ...h.state.identity };
      const preview = await h.call("reports/weekly");
      assert.equal(preview.status, 200);
      assert.match(preview.headers.get("cache-control"), /no-store/);
      assert.doesNotMatch(JSON.stringify(preview.data), /Private reason|fixture-key|fixture-weekly-cron/);
      assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM weekly_report_deliveries").get().n, 0);
      for (const role of ["teacher", "moderator"]) {
        h.sqlite.prepare("UPDATE app_users SET role=? WHERE id=?").run(role, owner.memberId);
        assert.equal((await h.call("reports/weekly")).status, 403);
      }
      h.state.identity = null;
      assert.equal((await h.call("reports/weekly")).status, 401);
    });
  } finally { h.close(); }
});

test("pre-migration preview keeps school records visible and requires a database update when only the ledger is missing", async () => {
  const h = await harness();
  try {
    h.student(); h.assignment();
    h.sqlite.exec("DROP TABLE weekly_report_deliveries");
    const preview = await h.service.weeklyReportPreview(h.db, { now: friday, env: safeEnv, previewOrigin: "https://reflection.example.edu" });
    assert.equal(preview.preview.metrics.initial, 1);
    assert.match(preview.preview.text, /Private pupil-a/);
    assert.equal(preview.lastDelivery, null);
    assert.equal(preview.readiness.enabled, true);
    assert.equal(preview.readiness.ready, false);
    assert.deepEqual(preview.readiness.missing, ["Database update"]);
    assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM reflection_assignments").get().n, 1);
    assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='weekly_report_deliveries'").get().n, 0);
    await withEnvironment(safeEnv, async () => {
      const response = await h.call("reports/weekly");
      assert.equal(response.status, 200);
      assert.equal(response.data.readiness.ready, false);
      assert.ok(response.data.readiness.missing.includes("Database update"));
      assert.match(response.headers.get("cache-control"), /no-store/);
      assert.doesNotMatch(JSON.stringify(response.data), /no such table|SQLITE_|fixture-key|fixture-weekly-cron/);
    });
  } finally { h.close(); }
});

test("preview recognises a wrapped remote missing-ledger error without hiding other database failures", async () => {
  const h = await harness();
  try {
    h.student(); h.assignment();
    const remoteMissing = new Error("Query transport wrapper", { cause: new LibsqlError("SQLite error: no such table: main.weekly_report_deliveries", "SQLITE_UNKNOWN") });
    let failure = remoteMissing;
    h.state.beforeQuery = sql => { if (sql.includes('from "weekly_report_deliveries"')) throw failure; };
    const recovered = await h.service.weeklyReportPreview(h.db, { now: friday, env: safeEnv, previewOrigin: "https://reflection.example.edu" });
    assert.equal(recovered.readiness.ready, false);
    assert.deepEqual(recovered.readiness.missing, ["Database update"]);
    for (const error of [
      new LibsqlError("Database connection unavailable", "SERVER_ERROR"),
      new LibsqlError("Not authorised", "AUTH_ERROR"),
      new LibsqlError("no such table: students", "SQLITE_ERROR"),
      new LibsqlError("no such column: weekly_report_deliveries.week_key", "SQLITE_ERROR"),
      new LibsqlError('near "from": syntax error', "SQLITE_ERROR"),
      new Error("no such table: weekly_report_deliveries"),
    ]) {
      failure = error;
      await assert.rejects(h.service.weeklyReportPreview(h.db, { now: friday, env: safeEnv, previewOrigin: "https://reflection.example.edu" }), caught => {
        for (let cause = caught, depth = 0; cause && depth < 8; cause = cause.cause, depth++) if (cause === error) return true;
        return false;
      });
    }
    h.state.beforeQuery = null;
    h.sqlite.exec("DROP TABLE reflection_assignments");
    await assert.rejects(h.service.weeklyReportPreview(h.db, { now: friday, env: safeEnv, previewOrigin: "https://reflection.example.edu" }));
  } finally { h.close(); }
});

test("missing delivery ledger fails the authenticated cron closed before any provider request", async () => {
  const h = await harness();
  const messages = [];
  const originalError = console.error;
  try {
    h.student(); h.assignment();
    h.sqlite.exec("DROP TABLE weekly_report_deliveries");
    let providerCalls = 0;
    const dispatch = () => h.service.dispatchWeeklyReport({ now: friday, env: safeEnv, db: h.db, fetcher: async () => { providerCalls++; return Response.json({ id: "must-not-send" }); } });
    const cron = moduleLoader({
      "@/app/lib/reflection-api": h.load("app/lib/reflection-api"),
      "@/app/lib/weekly-report-delivery": { dispatchWeeklyReport: dispatch },
    })("app/api/cron/weekly-report/route");
    console.error = (...args) => messages.push(args);
    await withEnvironment(safeEnv, async () => {
      const response = await cron.GET(new Request("https://reflection.example.edu/api/cron/weekly-report", { headers: { authorization: `Bearer ${safeEnv.CRON_SECRET}` } }));
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: "Weekly email delivery is unavailable." });
    });
    assert.equal(providerCalls, 0);
    assert.deepEqual(messages, [["Weekly report delivery could not be completed."]]);
    assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM reflection_assignments").get().n, 1);
  } finally { console.error = originalError; h.close(); }
});

test("cron requires a constant-time checked secret; anonymous or spoofed cron user-agent never gains access", async () => {
  const h = await harness();
  try {
    await withEnvironment({ ...safeEnv, WEEKLY_REPORT_ENABLED: "false" }, async () => {
      for (const headers of [{}, { "user-agent": "vercel-cron/1.0" }, { authorization: "Bearer wrong-secret" }]) {
        const response = await h.call("cron/weekly-report", headers);
        assert.equal(response.status, 401);
        assert.match(response.headers.get("cache-control"), /no-store/);
        assert.deepEqual(response.data, { error: "Not authorised." });
      }
      const disabled = await h.call("cron/weekly-report", { authorization: `Bearer ${safeEnv.CRON_SECRET}` });
      assert.deepEqual(disabled.data, { ok: true, status: "skipped", reason: "disabled" });
      assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM weekly_report_deliveries").get().n, 0);
    });
  } finally { h.close(); }
});
