import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { createTestDatabase } from "./libsql-test-db.mjs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const ownerTemplate = { authSource: "google", memberId: "owner-member-id", userId: "google:owner-auth-id", email: "owner@elitelac.com", displayName: "School Administrator", fullName: null };
const teacherTemplate = { authSource: "google", userId: "google:teacher-auth-id", email: "teacher@elitelac.com", displayName: "Untrusted Profile Name", fullName: null };
const behaviourSteps = { chance: true, choice: true, consequence: true, none: false };
// Deterministic source-calendar boundary for route tests. The actual closure
// selection remains in the shared production calendar module.
const testSchoolCalendar = {
  campus: "Fixture school", academicYear: "2026–2027",
  startDate: "2026-09-01", endDate: "2027-06-30", closedWeekdays: [0, 6],
  closures: [{ start: "2026-10-27", end: "2026-10-28", label: "Fixture school holiday" }],
  source: { url: "https://example.invalid/test-calendar", verifiedAt: "2026-11-04" },
};

// Exercise production routes, SQLite constraints and atomic batches through the
// real libSQL driver. Only the verified identity boundary is substituted.
async function harness({ seedOwner = true } = {}) {
  const owner = { ...ownerTemplate };
  const teacher = { ...teacherTemplate };
  const state = { identity: owner, beforeQuery: null, previewAllowed: false };
  const transport = await createTestDatabase({ beforeQuery: (sql, params) => state.beforeQuery?.(sql, params) });
  const { sqlite, db } = transport;
  if (seedOwner) sqlite.prepare("INSERT INTO app_users (id,email,name,role,status,created_at) VALUES (?,?,?,?,?,?)")
    .run(owner.memberId, owner.email, owner.displayName, "admin", "active", "2026-10-22");
  const modules = new Map();
  function load(relativePath) {
    const absolutePath = path.join(projectRoot, relativePath.endsWith(".ts") ? relativePath : `${relativePath}.ts`);
    if (modules.has(absolutePath)) return modules.get(absolutePath).exports;
    const loadedModule = { exports: {} };
    modules.set(absolutePath, loadedModule);
    const compiled = ts.transpileModule(readFileSync(absolutePath, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      fileName: absolutePath,
    }).outputText;
    const localRequire = (specifier) => {
      if (specifier === "./casa-school-calendar.json") return testSchoolCalendar;
      if (specifier === "@/db") return { getDb: () => db };
      if (specifier === "@/app/chatgpt-auth") return { getChatGPTUser: async () => state.identity };
      if (specifier === "@/app/lib/staff-auth") return {
        getStaffIdentity: async () => state.identity,
        allowsPreviewIdentity: () => state.previewAllowed,
      };
      if (specifier === "@/app/lib/school-auth-config") return { SCHOOL_DOMAIN: "elitelac.com", INITIAL_ADMIN_EMAIL: "t-wiam-zahri@elitelac.com" };
      if (specifier.startsWith("@/")) return load(specifier.slice(2));
      return require(specifier);
    };
    new Function("require", "module", "exports", compiled)(localRequire, loadedModule, loadedModule.exports);
    return loadedModule.exports;
  }
  async function call(routePath, method = "GET", body, id) {
    const request = new Request(`https://reflection.example.edu/api/${routePath}`, {
      method,
      headers: method === "GET" ? {} : { "content-type": "application/json", origin: "https://reflection.example.edu" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const response = await load(`app/api/${routePath}/route`)[method](request, { params: Promise.resolve({ id }) });
    return { status: response.status, data: await response.json() };
  }
  return { sqlite, state, call, load, owner, teacher, close: transport.close };
}

async function inviteTeacher(h) {
  const created = await h.call("users", "POST", { name: "Verified Teacher", email: h.teacher.email, role: "teacher" });
  assert.equal(created.status, 200);
  h.teacher.memberId = created.data.user.id;
  return created.data.user;
}

test("verified school identities require active preprovisioned membership", async () => {
  const h = await harness();
  const { owner, teacher } = h;
  try {
    const first = await h.call("data");
    assert.equal(first.status, 200);
    assert.equal(first.data.user.role, "admin");
    h.state.identity = { ...teacher, email: "stranger@elitelac.com", userId: "google:stranger-id" };
    assert.equal((await h.call("data")).status, 403);
    assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM app_users").get().count, 1);
    h.state.identity = owner;
    const invited = await inviteTeacher(h);
    h.state.identity = teacher;
    const admitted = await h.call("data");
    assert.equal(admitted.data.user.role, "teacher");
    assert.equal(admitted.data.user.name, "Verified Teacher");
    assert.equal("users" in admitted.data, false);
    h.state.identity = owner;
    assert.equal((await h.call("users/[id]", "PATCH", { status: "disabled" }, invited.id)).status, 200);
    h.state.identity = teacher;
    assert.equal((await h.call("data")).status, 403);
    h.state.identity = null;
    assert.equal((await h.call("data")).status, 401);
  } finally { h.close(); }
});

test("administrators can add only exact school-domain accounts without changing existing access", async () => {
  const h = await harness();
  const { owner, teacher } = h;
  try {
    assert.equal((await h.call("data")).status, 200);
    for (const email of ["staff@example.edu", "staff@other.elitelac.com", "staff@elitelac.com.evil.example"]) {
      const denied = await h.call("users", "POST", { name: "New Staff", email, role: "teacher" });
      assert.equal(denied.status, 400);
      assert.match(denied.data.error, /@elitelac\.com/);
    }
    assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM app_users").get().count, 1);
    const created = await h.call("users", "POST", { name: "School Teacher", email: " School.Teacher@EliteLac.com ", role: "teacher" });
    assert.equal(created.status, 200);
    assert.equal(created.data.user.email, "school.teacher@elitelac.com");
    assert.equal(created.data.user.role, "teacher");
    assert.equal((await h.call("data")).data.user.email, owner.email);
  } finally { h.close(); }
});

test("teachers can record verified attendance but cannot manage staff or pupils", async () => {
  const h = await harness();
  const { owner, teacher } = h;
  try {
    await h.call("data");
    const invited = await inviteTeacher(h);
    assert.equal((await h.call("students", "POST", { source: "Test roster", students: [{ name: "Test Pupil", grade: "Grade 7", className: "7A" }] })).status, 200);
    const pupil = (await h.call("data")).data.students[0];
    assert.equal(pupil.active, true);
    h.state.identity = teacher;
    for (const [route, method, body, id] of [
      ["users", "GET"],
      ["users", "POST", { name: "Other Teacher", email: "other@example.edu", role: "teacher" }],
      ["users/[id]", "PATCH", { role: "admin" }, invited.id],
      ["students", "POST", { source: "Test", students: [{ name: "Other Pupil", grade: "Grade 7", className: "7A" }] }],
      ["students/[id]", "PATCH", { name: "Changed Name" }, pupil.id],
      ["students/[id]", "DELETE", undefined, pupil.id],
    ]) assert.equal((await h.call(route, method, body, id)).status, 403);

    const payload = { studentIds: [pupil.id], date: "2026-10-22", slots: ["lunch"], reasonCategory: "disruption", behaviourSteps, assignedBy: "Freeform name" };
    assert.deepEqual((await h.call("assignments", "POST", payload)).data, { ok: true, created: 1, skipped: 0 });
    assert.equal((await h.call("assignments", "POST", payload)).status, 409);
    const assignment = (await h.call("data")).data.assignments[0];
    const marked = await h.call("assignments/[id]", "PATCH", { status: "present", attendanceRecordedBy: "Spoofed actor" }, assignment.id);
    assert.equal(marked.status, 200);
    assert.equal(marked.data.attendanceRecordedBy, "Verified Teacher");
    assert.ok(marked.data.attendanceRecordedAt);
    const saved = (await h.call("data")).data.assignments.find((item) => item.id === assignment.id);
    assert.equal(saved.status, "present");
    assert.equal(saved.attendanceRecordedBy, "Verified Teacher");
    assert.equal(saved.attendanceRecordedAt, marked.data.attendanceRecordedAt);
    assert.equal((await h.call("assignments/[id]", "PATCH", { status: "pending" }, assignment.id)).data.attendanceRecordedBy, "Verified Teacher");

    h.state.identity = owner;
    assert.equal((await h.call("students/[id]", "DELETE", undefined, pupil.id)).status, 200);
    h.state.identity = teacher;
    assert.equal((await h.call("assignments", "POST", { ...payload, date: "2026-10-26" })).status, 400);
    assert.equal((await h.call("data")).data.students[0].active, false);
    assert.equal((await h.call("data")).data.assignments.length, 1);
  } finally { h.close(); }
});

test("administrators cannot disable or demote themselves; last-admin guard survives an intervening change", async () => {
  const h = await harness();
  const { owner, teacher } = h;
  try {
    const initial = await h.call("data");
    const ownId = initial.data.users[0].id;
    assert.equal((await h.call("users/[id]", "PATCH", { status: "disabled" }, ownId)).status, 409);
    assert.equal((await h.call("users/[id]", "PATCH", { role: "teacher" }, ownId)).status, 409);
    assert.equal((await h.call("users/[id]", "PATCH", { role: "moderator" }, ownId)).status, 409);
    const other = await h.call("users", "POST", { name: "Second Administrator", email: "second@elitelac.com", role: "admin" });
    h.state.beforeQuery = (sql) => {
      if (sql.startsWith('update "app_users" set "role"')) {
        h.state.beforeQuery = null;
        h.sqlite.prepare("UPDATE app_users SET role = 'teacher' WHERE id = ?").run(ownId);
      }
    };
    const guarded = await h.call("users/[id]", "PATCH", { role: "teacher" }, other.data.user.id);
    assert.equal(guarded.status, 409);
    assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM app_users WHERE role = 'admin' AND status = 'active'").get().count, 1);
  } finally { h.close(); }
});

test("concurrent verified identities cannot self-register or create another administrator", async () => {
  const h = await harness();
  const { owner, teacher } = h;
  try {
    const first = h.call("data");
    h.state.identity = teacher;
    const second = h.call("data");
    const results = await Promise.all([first, second]);
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 403]);
    assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM app_users").get().count, 1);
  } finally { h.close(); }
});

async function missedFixture(h, status = "absent") {
  await h.call("data");
  await inviteTeacher(h);
  await h.call("students", "POST", { source: "Test roster", students: [
    { name: "Test Pupil", grade: "Grade 7", className: "7A" },
    { name: "Other Pupil", grade: "Grade 7", className: "7B" },
  ] });
  const students = (await h.call("data")).data.students;
  const pupil = students.find((student) => student.name === "Test Pupil");
  const other = students.find((student) => student.id !== pupil.id);
  h.state.identity = h.teacher;
  const id = "legacy-morning-fixture";
  h.sqlite.prepare(`INSERT INTO reflection_assignments
    (id,student_id,date,slot,reason,assigned_by,status,created_at,updated_at,created_by_user_id,updated_by_user_id,attendance_recorded_by,attendance_recorded_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, pupil.id, "2026-10-22", "morning", "Original reflection reason", "Verified Teacher", status, "2026-10-22", "2026-10-22", h.teacher.userId, h.teacher.userId,
      status === "absent" ? "Verified Teacher" : null, status === "absent" ? "2026-10-22T12:00:00.000Z" : null);
  return { pupil, other, source: (await h.call("data")).data.assignments[0] };
}

test("one absence books two available lunches and keeps the original teacher attribution", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-23T12:00:00Z") });
  const h = await harness();
  try {
    const { pupil, source } = await missedFixture(h, "pending");
    assert.equal((await h.call("assignments", "POST", {
      studentIds: [pupil.id], date: "2026-10-26", slots: ["lunch"], reasonCategory: "disruption", behaviourSteps,
    })).status, 200);
    h.state.identity = h.owner;
    const first = await h.call("assignments/[id]", "PATCH", { status: "absent" }, source.id);
    assert.equal(first.status, 200);
    assert.deepEqual(first.data.followUps.map(row => row.date), ["2026-10-29", "2026-11-02"]);
    assert.deepEqual(first.data.followUp, first.data.followUps[0]);
    t.mock.timers.tick(1000);
    const retry = await h.call("assignments/[id]", "PATCH", { status: "absent" }, source.id);
    assert.deepEqual(retry, first);
    const assignments = (await h.call("data")).data.assignments;
    const original = assignments.find(row => row.id === source.id);
    const followUps = first.data.followUps.map(followUp => assignments.find(row => row.id === followUp.id));
    assert.equal(original.status, "absent");
    assert.equal(original.date, source.date);
    assert.equal(original.rescheduledToId, followUps[0].id);
    assert.deepEqual(original.rescheduledToIds, followUps.map(row => row.id));
    assert.equal(original.canCorrectAttendance, true);
    for (const followUp of followUps) {
      assert.equal(followUp.reason, source.reason);
      assert.equal(followUp.assignedBy, source.assignedBy);
      assert.equal(followUp.status, "pending");
      assert.equal(followUp.slot, "lunch");
      assert.equal(followUp.rescheduledFromId, source.id);
      const saved = h.sqlite.prepare("SELECT created_by_user_id FROM reflection_assignments WHERE id = ?").get(followUp.id);
      assert.equal(saved.created_by_user_id, h.teacher.userId);
    }
    const insights = (await h.call("insights")).data;
    assert.equal(insights.students.find(row => row.id === pupil.id).className, "7A");
    assert.equal(insights.assignments.filter(row => row.status === "absent").length, 1);
    const sourceTeacherId = insights.assignments.find(row => row.id === source.id).teacherId;
    assert.equal(insights.teachers.find(row => row.id === sourceTeacherId).name, source.assignedBy);
    assert.deepEqual(insights.assignments.filter(row => row.rescheduledFromId === source.id)
      .map(row => ({ id: row.id, teacherId: row.teacherId })), followUps.map(row => ({ id: row.id, teacherId: sourceTeacherId })));
    const activity = (await h.call("activity")).data.events;
    assert.equal(activity.filter(event => event.action === "attendance.recorded" && event.targetId === source.id).length, 1);
    const automatic = activity.filter(event => ["reflection.auto_rescheduled", "reflection.auto_extra"].includes(event.action));
    assert.equal(automatic.length, 2);
    assert.ok(automatic.every(event => event.actorId === h.owner.memberId));
  } finally { h.close(); }
});

test("recording a past absence starts booking after today's lunch", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-02T13:00:00Z") });
  const h = await harness();
  try {
    const { source } = await missedFixture(h, "pending");
    const result = await h.call("assignments/[id]", "PATCH", { status: "absent" }, source.id);
    assert.equal(result.status, 200);
    assert.deepEqual(result.data.followUps.map(row => row.date), ["2026-11-03", "2026-11-04"]);
  } finally { h.close(); }
});

test("an attendance correction cancels both pending bookings and protects an attended extra", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-22T12:00:00Z") });
  const h = await harness();
  try {
    const { source } = await missedFixture(h, "pending");
    const first = (await h.call("assignments/[id]", "PATCH", { status: "absent" }, source.id)).data.followUps;
    const corrected = await h.call("assignments/[id]", "PATCH", { status: "present" }, source.id);
    assert.equal(corrected.status, 200);
    assert.equal(corrected.data.followUpCancelled, true);
    for (const row of first) assert.ok(h.sqlite.prepare("SELECT cancelled_at FROM reflection_assignments WHERE id = ?").get(row.id).cancelled_at);
    assert.equal((await h.call("data")).data.assignments.find(row => row.id === source.id).status, "present");

    const second = (await h.call("assignments/[id]", "PATCH", { status: "absent" }, source.id)).data.followUps;
    assert.notDeepEqual(second, first);
    assert.deepEqual(second.map(row => row.date), first.map(row => row.date));
    assert.equal((await h.call("assignments/[id]", "PATCH", { status: "present" }, second[1].id)).status, 200);
    assert.equal((await h.call("assignments/[id]", "PATCH", { status: "present" }, source.id)).status, 409);
    const assignments = (await h.call("data")).data.assignments;
    assert.equal(assignments.find(row => row.id === source.id).canCorrectAttendance, undefined);
    assert.equal(assignments.find(row => row.id === second[0].id).status, "pending");
    assert.equal(assignments.find(row => row.id === second[1].id).status, "present");
  } finally { h.close(); }
});

test("concurrent absent marks book one pair and a missed follow-up keeps the original extra", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-22T12:00:00Z") });
  const h = await harness();
  try {
    const { source } = await missedFixture(h, "pending");
    const first = await Promise.all([
      h.call("assignments/[id]", "PATCH", { status: "absent" }, source.id),
      h.call("assignments/[id]", "PATCH", { status: "absent" }, source.id),
    ]);
    assert.deepEqual(first.map(result => result.status), [200, 200]);
    assert.deepEqual(first[0].data.followUps, first[1].data.followUps);
    const [replacement, extra] = first[0].data.followUps;
    assert.deepEqual([replacement.date, extra.date], ["2026-10-26", "2026-10-29"]);
    t.mock.timers.tick(86400000);
    const missed = await h.call("assignments/[id]", "PATCH", { status: "absent" }, replacement.id);
    assert.equal(missed.status, 200);
    assert.deepEqual(missed.data.followUps.map(row => row.date), ["2026-11-02", "2026-11-03"]);
    const assignments = (await h.call("data")).data.assignments;
    assert.deepEqual(assignments.map(row => row.status), ["absent", "absent", "pending", "pending", "pending"]);
    assert.equal(assignments.find(row => row.id === extra.id).rescheduledFromId, source.id);
  } finally { h.close(); }
});

test("a surviving extra prevents duplicate bookings, rescheduling and deleting the source", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-22T12:00:00Z") });
  const h = await harness();
  try {
    const { source } = await missedFixture(h, "pending");
    const [replacement, extra] = (await h.call("assignments/[id]", "PATCH", { status: "absent" }, source.id)).data.followUps;
    assert.equal((await h.call("assignments/[id]", "DELETE", {}, replacement.id)).status, 200);
    const retry = await h.call("assignments/[id]", "PATCH", { status: "absent" }, source.id);
    assert.equal(retry.status, 200);
    assert.deepEqual(retry.data.followUps, [extra]);
    assert.equal((await h.call("assignments/[id]", "DELETE", {}, source.id)).status, 409);
    assert.equal((await h.call("assignments/[id]/reschedule", "POST", { date: "2026-11-02", slot: "lunch" }, source.id)).status, 409);
    const assignments = (await h.call("data")).data.assignments;
    assert.equal(assignments.find(row => row.id === source.id).rescheduledToId, extra.id);
    assert.equal(assignments.find(row => row.id === extra.id).rescheduledFromId, source.id);
    assert.equal((await h.call("assignments/[id]", "PATCH", { status: "present" }, source.id)).status, 200);
    assert.ok(h.sqlite.prepare("SELECT cancelled_at FROM reflection_assignments WHERE id = ?").get(extra.id).cancelled_at);
  } finally { h.close(); }
});

test("retrying an absence with a historical single automatic booking keeps that booking", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-22T12:00:00Z") });
  const h = await harness();
  try {
    const { source, pupil } = await missedFixture(h);
    const historical = { id: "legacy-single-follow-up", date: "2026-10-23" };
    h.sqlite.prepare(`INSERT INTO reflection_assignments
      (id,student_id,date,slot,reason,assigned_by,status,created_at,updated_at,created_by_user_id,updated_by_user_id,rescheduled_from_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(historical.id, pupil.id, historical.date, "lunch", source.reason,
      source.assignedBy, "pending", "2026-10-22", "2026-10-22", h.teacher.userId, h.teacher.userId, source.id);
    h.sqlite.prepare(`INSERT INTO activity_events
      (id,actor_id,actor_name,action,target_type,target_id,target_name,details,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run("legacy-auto-event", h.teacher.memberId, source.assignedBy,
      "reflection.auto_rescheduled", "reflection", historical.id, pupil.name, "Historic automatic booking", "2026-10-22");
    const retry = await h.call("assignments/[id]", "PATCH", { status: "absent" }, source.id);
    assert.equal(retry.status, 200);
    assert.deepEqual(retry.data.followUps, [historical]);
    assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM reflection_assignments").get().n, 2);
  } finally { h.close(); }
});

test("attendance is saved without bookings when only one eligible date remains or a student is archived", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2027-06-29T12:00:00Z") });
  const h = await harness();
  try {
    const { source, pupil } = await missedFixture(h, "pending");
    h.sqlite.prepare("UPDATE reflection_assignments SET date = '2027-06-29' WHERE id = ?").run(source.id);
    const atCalendarEnd = await h.call("assignments/[id]", "PATCH", { status: "absent" }, source.id);
    assert.equal(atCalendarEnd.status, 200);
    assert.equal(atCalendarEnd.data.followUp, null);
    assert.deepEqual(atCalendarEnd.data.followUps, []);
    assert.equal(atCalendarEnd.data.followUpUnavailable, "calendar");
    assert.equal(h.sqlite.prepare("SELECT status FROM reflection_assignments WHERE id = ?").get(source.id).status, "absent");
    assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM reflection_assignments").get().n, 1);
    await h.call("assignments/[id]", "PATCH", { status: "pending" }, source.id);
    h.sqlite.prepare("UPDATE students SET active = 0 WHERE id = ?").run(pupil.id);
    const archived = await h.call("assignments/[id]", "PATCH", { status: "absent" }, source.id);
    assert.equal(archived.status, 200);
    assert.equal(archived.data.followUpUnavailable, "archived");
    assert.equal(h.sqlite.prepare("SELECT status FROM reflection_assignments WHERE id = ?").get(source.id).status, "absent");
    assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM reflection_assignments").get().n, 1);
  } finally { h.close(); }
});

test("an extra follow-up audit failure rolls back the absence and both bookings", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-22T12:00:00Z") });
  const h = await harness();
  const originalError = console.error;
  try {
    const { source } = await missedFixture(h, "pending");
    h.sqlite.exec(`CREATE TRIGGER reject_followup_audit BEFORE INSERT ON activity_events
      WHEN NEW.action = 'reflection.auto_extra' BEGIN SELECT RAISE(ABORT, 'test audit unavailable'); END`);
    console.error = () => {};
    assert.equal((await h.call("assignments/[id]", "PATCH", { status: "absent" }, source.id)).status, 500);
    assert.equal(h.sqlite.prepare("SELECT status FROM reflection_assignments WHERE id = ?").get(source.id).status, "pending");
    assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM reflection_assignments").get().n, 1);
    assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM activity_events WHERE action IN ('attendance.recorded', 'reflection.auto_rescheduled')").get().n, 0);
  } finally { console.error = originalError; h.close(); }
});

test("stale clients cannot book morning or both breaks, and historical morning attendance remains visible", async () => {
  const h = await harness();
  try {
    const { pupil, source } = await missedFixture(h);
    const activityBefore = h.sqlite.prepare("SELECT count(*) AS n FROM activity_events").get().n;
    for (const slots of [["morning"], ["morning", "lunch"]]) {
      const result = await h.call("assignments", "POST", { studentIds: [pupil.id], date: "2026-10-26", slots, reasonCategory: "disruption", behaviourSteps });
      assert.equal(result.status, 400);
      assert.match(result.data.error, /lunch break only/);
    }
    const replacement = await h.call("assignments/[id]/reschedule", "POST", { date: "2026-10-26", slot: "morning" }, source.id);
    assert.equal(replacement.status, 400);
    assert.match(replacement.data.error, /lunch break only/);
    assert.equal(source.slot, "morning");
    assert.equal(source.status, "absent");
    assert.deepEqual((await h.call("data")).data.assignments, [source]);
    assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM activity_events").get().n, activityBefore);
  } finally { h.close(); }
});

test("the lunch move preview and apply require an administrator and a valid plan ID", async () => {
  const h = await harness();
  try {
    const { source } = await missedFixture(h);
    assert.equal((await h.call("assignments/[id]", "PATCH", { status: "pending" }, source.id)).status, 200);
    const before = h.sqlite.prepare("SELECT * FROM reflection_assignments WHERE id = ?").get(source.id);
    const activityBefore = h.sqlite.prepare("SELECT count(*) AS n FROM activity_events").get().n;
    const route = "assignments/lunch-cutover";

    h.state.identity = h.owner;
    const preview = await h.call(route);
    assert.equal(preview.status, 200);
    assert.match(preview.data.planId, /^[a-f0-9]{64}$/);
    assert.equal(preview.data.moves.length + preview.data.blocked.length, 1);

    for (const [identity, status] of [[h.teacher, 403], [null, 401]]) {
      h.state.identity = identity;
      assert.equal((await h.call(route)).status, status);
      assert.equal((await h.call(route, "POST", { planId: preview.data.planId })).status, status);
    }

    h.state.identity = h.owner;
    for (const payload of [null, {}, { planId: 42 }, { planId: "a".repeat(63) }, { planId: "g".repeat(64) }]) {
      const rejected = await h.call(route, "POST", payload);
      assert.equal(rejected.status, 400);
      assert.match(rejected.data.error, /Review the proposed moves/);
    }
    assert.deepEqual(h.sqlite.prepare("SELECT * FROM reflection_assignments WHERE id = ?").get(source.id), before);
    assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM activity_events").get().n, activityBefore);
  } finally { h.close(); }
});

test("new reflections require an approved reason while Insights exposes only safe reason labels", async () => {
  const h = await harness();
  try {
    const { pupil, source } = await missedFixture(h);
    const before = h.sqlite.prepare("SELECT count(*) AS n FROM reflection_assignments").get().n;
    const activityBefore = h.sqlite.prepare("SELECT count(*) AS n FROM activity_events").get().n;
    const base = { studentIds: [pupil.id], date: "2026-10-26", slots: ["lunch"], behaviourSteps };
    const invalid = [
      [{ reason: "Legacy client text" }, /Select a reason/],
      [{ reasonCategory: "pretend-category" }, /Select a reason/],
      [{ reasonCategory: "other", reasonDetails: "\u200b\u2060" }, /Other reason details is required/],
      [{ reasonCategory: "other", reasonDetails: "x".repeat(994) }, /993 characters/],
    ];
    for (const [reason, message] of invalid) {
      const result = await h.call("assignments", "POST", { ...base, ...reason });
      assert.equal(result.status, 400);
      assert.match(result.data.error, message);
      assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM reflection_assignments").get().n, before);
      assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM activity_events").get().n, activityBefore);
    }
    assert.equal((await h.call("assignments", "POST", { ...base, reasonCategory: "disruption", reasonDetails: "Ignore extra text" })).status, 200);
    assert.equal((await h.call("assignments", "POST", {
      ...base, date: "2026-10-29", reasonCategory: "other", reasonDetails: "  Private\n description.  ",
    })).status, 200);
    const saved = h.sqlite.prepare("SELECT date, reason FROM reflection_assignments WHERE slot = 'lunch' ORDER BY date").all();
    assert.deepEqual(saved.map(row => row.reason), ["Disruption in class", "Other: Private description."]);
    h.state.identity = h.owner;
    const insights = await h.call("insights");
    assert.equal(insights.status, 200);
    assert.equal(insights.data.assignments.find(row => row.id === source.id).reasonCategory, "Previous reasons");
    assert.deepEqual(insights.data.assignments.filter(row => row.slot === "lunch").map(row => row.reasonCategory), ["Disruption in class", "Other"]);
    assert.ok(insights.data.assignments.every(row => !("reason" in row)));
    assert.ok(!JSON.stringify(insights.data).includes("Private description."));
    assert.ok(!JSON.stringify(insights.data).includes(source.reason));
  } finally { h.close(); }
});

test("new bookings require a behaviour selection and record the selected options", async () => {
  const h = await harness();
  try {
    const { pupil } = await missedFixture(h);
    const before = h.sqlite.prepare("SELECT count(*) AS n FROM reflection_assignments").get().n;
    const input = { studentIds: [pupil.id], date: "2026-10-26", slots: ["lunch"], reasonCategory: "disruption" };
    const noSteps = { chance: false, choice: false, consequence: false, none: false };
    for (const [steps, message] of [
      [undefined, /Select Choice, Chance and Consequence/],
      [noSteps, /Select Choice, Chance and Consequence/],
      [{ ...behaviourSteps, choice: false }, /Select Choice, Chance and Consequence/],
      [{ ...behaviourSteps, consequence: "true" }, /Select Choice, Chance and Consequence/],
      [{ ...noSteps, chance: true, none: true }, /Select None of the above on its own/],
      [{ ...noSteps, none: true }, /Explanation is required/],
      [{ ...noSteps, none: true, explanation: "\u200b\u2800" }, /Explanation is required/],
    ]) {
      const result = await h.call("assignments", "POST", { ...input, behaviourSteps: steps });
      assert.equal(result.status, 400);
      assert.match(result.data.error, message);
    }
    assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM reflection_assignments").get().n, before);
    assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM activity_events WHERE action = 'reflection.assigned'").get().n, 0);
    const selections = [
      ["2026-10-22", behaviourSteps, "Choice, Chance, Consequence"],
      ["2026-10-26", { ...noSteps, none: true, explanation: "  Same day\n incident.  " }, "None of the above — Same day incident."],
    ];
    for (const [date, steps] of selections) {
      assert.equal((await h.call("assignments", "POST", { ...input, date, behaviourSteps: steps })).status, 200);
    }
    const events = h.sqlite.prepare("SELECT details FROM activity_events WHERE action = 'reflection.assigned' ORDER BY details").all();
    assert.deepEqual(events.map(event => event.details),
      selections.map(([date, , labels]) => `${date} · Lunch break · Behaviour steps: ${labels}`));
  } finally { h.close(); }
});

test("server rejects stale clients assigning Fridays, weekends, holidays and unverified calendar dates without writes", async () => {
  const h = await harness();
  try {
    const { pupil } = await missedFixture(h);
    const before = h.sqlite.prepare("SELECT count(*) AS n FROM reflection_assignments").get().n;
    const activityBefore = h.sqlite.prepare("SELECT count(*) AS n FROM activity_events").get().n;
    const closedDates = [
      ["2026-10-23", /Monday through Thursday/],
      ["2026-10-24", /weekends/],
      ["2026-10-25", /weekends/],
      ["2026-10-27", /Fixture school holiday/],
      ["2026-10-28", /Fixture school holiday/],
      ["2027-07-01", /outside the verified school calendar/],
    ];
    for (const [date, message] of closedDates) {
      const result = await h.call("assignments", "POST", { studentIds: [pupil.id], date, slots: ["lunch"], reasonCategory: "disruption", behaviourSteps, calendarOverride: true });
      assert.equal(result.status, 400);
      assert.match(result.data.error, message);
      assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM reflection_assignments").get().n, before);
      assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM activity_events").get().n, activityBefore);
    }
    assert.equal((await h.call("assignments", "POST", { studentIds: [pupil.id], date: "2026-10-29", slots: ["lunch"], reasonCategory: "disruption", behaviourSteps })).status, 200);
  } finally { h.close(); }
});

test("closed-date reschedules retain the original absence, and legacy blank reasons remain readable and reschedulable", async () => {
  const h = await harness();
  try {
    const { source } = await missedFixture(h);
    h.sqlite.prepare("UPDATE reflection_assignments SET reason='' WHERE id=?").run(source.id);
    const before = h.sqlite.prepare("SELECT * FROM reflection_assignments WHERE id=?").get(source.id);
    const activityBefore = h.sqlite.prepare("SELECT count(*) AS n FROM activity_events").get().n;
    for (const date of ["2026-10-23", "2026-10-24", "2026-10-27", "2026-10-28", "2027-07-01"]) {
      const result = await h.call("assignments/[id]/reschedule", "POST", { date, slot: "lunch" }, source.id);
      assert.equal(result.status, 400);
      assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM reflection_assignments").get().n, 1);
      assert.deepEqual(h.sqlite.prepare("SELECT * FROM reflection_assignments WHERE id=?").get(source.id), before);
      assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM activity_events").get().n, activityBefore);
    }
    const result = await h.call("assignments/[id]/reschedule", "POST", { date: "2026-10-26", slot: "lunch" }, source.id);
    assert.equal(result.status, 200);
    assert.equal(h.sqlite.prepare("SELECT reason FROM reflection_assignments WHERE id=?").get(result.data.assignmentId).reason, "");
    assert.deepEqual(h.sqlite.prepare("SELECT * FROM reflection_assignments WHERE id=?").get(source.id), before);
    const data = (await h.call("data")).data;
    assert.equal(data.assignments.find(item => item.id === source.id).status, "absent");
    assert.equal(data.assignments.find(item => item.id === source.id).reason, "");
  } finally { h.close(); }
});

test("rescheduling preserves the original absence and creates one verified pending replacement", async () => {
  const h = await harness();
  const { owner, teacher } = h;
  try {
    const { pupil, other, source } = await missedFixture(h);
    const result = await h.call("assignments/[id]/reschedule", "POST", {
      date: source.date, slot: "lunch", studentId: other.id, assignedBy: "Spoofed actor", reason: "Spoofed reason",
    }, source.id);
    assert.equal(result.status, 200);
    const assignments = (await h.call("data")).data.assignments;
    const original = assignments.find((assignment) => assignment.id === source.id);
    const replacement = assignments.find((assignment) => assignment.id === result.data.assignmentId);
    assert.deepEqual({ ...original, rescheduledToId: null }, source);
    assert.equal(original.rescheduledToId, replacement.id);
    assert.equal(replacement.rescheduledFromId, source.id);
    assert.equal(replacement.studentId, pupil.id);
    assert.equal(replacement.reason, source.reason);
    assert.equal(replacement.assignedBy, "Verified Teacher");
    assert.equal(replacement.status, "pending");
    assert.equal(replacement.attendanceRecordedBy, null);
    assert.equal(replacement.attendanceRecordedAt, null);
    assert.equal((await h.call("assignments/[id]", "PATCH", { status: "present" }, source.id)).status, 409);
    assert.equal((await h.call("assignments/[id]", "DELETE", undefined, source.id)).status, 409);
    assert.equal((await h.call("assignments/[id]/reschedule", "POST", { date: "2026-10-26", slot: "lunch" }, source.id)).status, 409);
  } finally { h.close(); }
});

test("cancelling a replacement reopens its absence and keeps cancelled audit rows", async () => {
  const h = await harness();
  const { owner, teacher } = h;
  try {
    const { source } = await missedFixture(h);
    const first = await h.call("assignments/[id]/reschedule", "POST", { date: "2026-10-26", slot: "lunch" }, source.id);
    assert.equal(first.status, 200);
    assert.equal((await h.call("assignments/[id]", "DELETE", undefined, first.data.assignmentId)).status, 200);
    const reopened = (await h.call("data")).data.assignments.find((assignment) => assignment.id === source.id);
    assert.deepEqual(reopened, source);
    const second = await h.call("assignments/[id]/reschedule", "POST", { date: "2026-10-26", slot: "lunch" }, source.id);
    assert.equal(second.status, 200);
    assert.notEqual(second.data.assignmentId, first.data.assignmentId);
    const old = h.sqlite.prepare("SELECT cancelled_at, rescheduled_from_id FROM reflection_assignments WHERE id = ?").get(first.data.assignmentId);
    assert.ok(old.cancelled_at);
    assert.equal(old.rescheduled_from_id, source.id);
    assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM reflection_assignments").get().count, 3);
  } finally { h.close(); }
});

test("reschedule rejects booked targets, invalid sources, earlier dates, and archived pupils without resolving the absence", async () => {
  const h = await harness();
  const { owner, teacher } = h;
  try {
    const { source, pupil } = await missedFixture(h);
    assert.equal((await h.call("assignments", "POST", { studentIds: [pupil.id], date: "2026-10-26", slots: ["lunch"], reasonCategory: "disruption", behaviourSteps })).status, 200);
    assert.equal((await h.call("assignments/[id]/reschedule", "POST", { date: "2026-10-26", slot: "lunch" }, source.id)).status, 409);
    assert.equal((await h.call("assignments/[id]/reschedule", "POST", { date: "2026-10-21", slot: "lunch" }, source.id)).status, 400);
    assert.equal((await h.call("assignments/[id]/reschedule", "POST", { date: "2026-10-26", slot: ["morning", "lunch"] }, source.id)).status, 400);
    assert.equal((await h.call("assignments/[id]/reschedule", "POST", { date: "2026-10-26", slot: "lunch" }, "missing-source")).status, 404);
    const data = (await h.call("data")).data;
    const pending = data.assignments.find((assignment) => assignment.id !== source.id);
    assert.equal((await h.call("assignments/[id]/reschedule", "POST", { date: "2026-10-26", slot: "lunch" }, pending.id)).status, 400);
    assert.deepEqual(data.assignments.find((assignment) => assignment.id === source.id), source);
    h.sqlite.prepare("UPDATE reflection_assignments SET status = 'absent' WHERE id = ?").run(pending.id);
    assert.equal((await h.call("assignments/[id]/reschedule", "POST", { date: pending.date, slot: "lunch" }, pending.id)).status, 409);
    h.state.identity = owner;
    await h.call("students/[id]", "DELETE", undefined, pupil.id);
    h.state.identity = teacher;
    assert.equal((await h.call("assignments/[id]/reschedule", "POST", { date: "2026-10-26", slot: "lunch" }, source.id)).status, 400);
    assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM reflection_assignments").get().count, 2);
  } finally { h.close(); }
});

test("concurrent reschedules create only one replacement and never alter the source attendance", async () => {
  const h = await harness();
  const { owner, teacher } = h;
  try {
    const { source } = await missedFixture(h);
    const results = await Promise.all([
      h.call("assignments/[id]/reschedule", "POST", { date: "2026-10-29", slot: "lunch" }, source.id),
      h.call("assignments/[id]/reschedule", "POST", { date: "2026-10-26", slot: "lunch" }, source.id),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
    const assignments = (await h.call("data")).data.assignments;
    assert.equal(assignments.length, 2);
    assert.equal(assignments.filter((assignment) => assignment.rescheduledFromId === source.id).length, 1);
    assert.deepEqual({ ...assignments.find((assignment) => assignment.id === source.id), rescheduledToId: null }, source);
  } finally { h.close(); }
});

test("bulk assignment conflicts roll back every selected pupil, including races", async () => {
  const h = await harness();
  const { owner, teacher } = h;
  try {
    const { source, pupil, other } = await missedFixture(h);
    assert.equal((await h.call("assignments", "POST", { studentIds: [pupil.id], date: source.date, slots: ["lunch"], reasonCategory: "disruption", behaviourSteps })).status, 200);
    const mixed = await h.call("assignments", "POST", { reasonCategory: "disruption", studentIds: [pupil.id, other.id], date: source.date, slots: ["lunch"], behaviourSteps });
    assert.equal(mixed.status, 409);
    assert.match(mixed.data.error, /Test Pupil/);
    assert.equal((await h.call("data")).data.assignments.length, 2);
    const results = await Promise.all([
      h.call("assignments", "POST", { reasonCategory: "disruption", studentIds: [pupil.id, other.id], date: "2026-10-26", slots: ["lunch"], behaviourSteps }),
      h.call("assignments", "POST", { reasonCategory: "disruption", studentIds: [pupil.id, other.id], date: "2026-10-26", slots: ["lunch"], behaviourSteps }),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
    assert.equal((await h.call("data")).data.assignments.length, 4);
  } finally { h.close(); }
});

test("a raced conflict in a later bulk statement rolls back earlier successful statements", async () => {
  const h = await harness();
  const { owner, teacher } = h;
  try {
    await h.call("data");
    const rows = [...Array.from({ length: 18 }, (_, index) => ({ name: `Pupil ${String(index).padStart(2, "0")}`, grade: "Grade 7", className: "7A" })),
      { name: "Shared Pupil", grade: "Grade 7", className: "7A" }];
    await h.call("students", "POST", { source: "Test roster", students: rows });
    const pupils = (await h.call("data")).data.students;
    const shared = pupils.find((pupil) => pupil.name === "Shared Pupil");
    const other = pupils.filter((pupil) => pupil.id !== shared.id);
    const firstIds = [...other.slice(0, 9).map((pupil) => pupil.id), shared.id];
    const secondIds = [...other.slice(9).map((pupil) => pupil.id), shared.id];
    const results = await Promise.all([
      h.call("assignments", "POST", { reasonCategory: "disruption", studentIds: firstIds, date: "2026-10-26", slots: ["lunch"], behaviourSteps }),
      h.call("assignments", "POST", { reasonCategory: "disruption", studentIds: secondIds, date: "2026-10-26", slots: ["lunch"], behaviourSteps }),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
    const savedIds = new Set((await h.call("data")).data.assignments.map((assignment) => assignment.studentId));
    assert.equal(savedIds.size, 10);
    const winner = results[0].status === 200 ? firstIds : secondIds;
    assert.deepEqual(savedIds, new Set(winner));
  } finally { h.close(); }
});

test("attendance correction and rescheduling cannot race into a present source with an active replacement", async () => {
  const h = await harness();
  const { owner, teacher } = h;
  try {
    const { source } = await missedFixture(h);
    const results = await Promise.all([
      h.call("assignments/[id]", "PATCH", { status: "present" }, source.id),
      h.call("assignments/[id]/reschedule", "POST", { date: "2026-10-26", slot: "lunch" }, source.id),
    ]);
    assert.equal(results.filter((result) => result.status === 200).length, 1);
    assert.ok(results.some((result) => result.status === 400 || result.status === 409));
    const assignments = (await h.call("data")).data.assignments;
    const original = assignments.find((assignment) => assignment.id === source.id);
    if (original.status === "present") {
      assert.equal(original.rescheduledToId, null);
      assert.equal(assignments.length, 1);
    } else {
      assert.equal(original.status, "absent");
      assert.ok(original.rescheduledToId);
      assert.equal(assignments.length, 2);
    }
  } finally { h.close(); }
});

test("distinct Toddle identities with the same name stay separate through reimport and profile edits", async () => {
  const h = await harness();
  const { owner, teacher } = h;
  try {
    await h.call("data");
    const rows = ["toddle-identity-1", "toddle-identity-2"].map(toddleId => ({ name: "Identical Test Name", grade: "Year 3", className: "Class to confirm", toddleId }));
    const first = await h.call("students", "POST", { source: "Toddle roster import", students: rows });
    assert.equal(first.status, 200);
    assert.equal(first.data.created, 2);
    const initial = (await h.call("data")).data.students;
    assert.equal(initial.length, 2);
    assert.equal(new Set(initial.map(student => student.id)).size, 2);
    assert.deepEqual(new Set(initial.map(student => student.toddleId)), new Set(rows.map(student => student.toddleId)));
    const repeated = await h.call("students", "POST", { source: "Toddle roster import", students: rows });
    assert.equal(repeated.data.created, 0);
    assert.equal(repeated.data.updated, 2);
    const student = initial[0];
    assert.equal((await h.call("students/[id]", "PATCH", { name: "Corrected Test Name", className: "3A" }, student.id)).status, 200);
    const edited = (await h.call("data")).data.students.find(row => row.id === student.id);
    assert.equal(edited.toddleId, student.toddleId);
    assert.equal(h.sqlite.prepare("SELECT roster_key FROM students WHERE id = ?").get(student.id).roster_key, `toddle:${student.toddleId}`);
    const updatedRows = rows.map(row => row.toddleId === student.toddleId ? { ...row, name: "Corrected Test Name", className: "3B" } : row);
    const updated = await h.call("students", "POST", { source: "Toddle roster import", students: updatedRows });
    assert.equal(updated.data.created, 0);
    const final = (await h.call("data")).data.students;
    assert.equal(final.length, 2);
    assert.equal(final.find(row => row.toddleId === student.toddleId).id, student.id);
    assert.equal(final.find(row => row.id === student.id).className, "3B");
    const conflict = await h.call("students", "POST", { source: "Toddle roster import", students: [rows[0], { ...rows[0], name: "Conflicting Name" }] });
    assert.equal(conflict.status, 400);
    assert.equal((await h.call("data")).data.students.length, 2);
    const genericAmbiguous = await h.call("students", "POST", { source: "CSV import", students: [{ name: "Identical Test Name", grade: "Year 3", className: "Class to confirm" }] });
    // Only one profile now has the original details; generic matching can update it.
    assert.equal(genericAmbiguous.status, 200);
    assert.equal(genericAmbiguous.data.created, 0);
    const unique = { name: "Unique Test Pupil", grade: "Year 3", className: "3C", toddleId: "toddle-identity-3" };
    await h.call("students", "POST", { source: "Toddle roster import", students: [unique] });
    const genericUnique = await h.call("students", "POST", { source: "CSV import", students: [{ name: unique.name, grade: unique.grade, className: unique.className }] });
    assert.equal(genericUnique.status, 200);
    assert.equal(genericUnique.data.created, 0);
    assert.equal((await h.call("data")).data.students.length, 3);
    const sameDetails = rows.map(row => ({ ...row, name: "Ambiguous Name", className: "Class to confirm" }));
    await h.call("students", "POST", { source: "Toddle roster import", students: sameDetails });
    const ambiguous = await h.call("students", "POST", { source: "CSV import", students: [{ name: "Ambiguous Name", grade: "Year 3", className: "Class to confirm" }] });
    assert.equal(ambiguous.status, 409);
    assert.equal((await h.call("data")).data.students.length, 3);
  } finally { h.close(); }
});

test("portal selection enforces actual active membership without writing roles or identities", async () => {
  const h = await harness();
  const { owner, teacher } = h;
  try {
    await h.call("data");
    const invited = await inviteTeacher(h);
    const { getPortalAccess } = h.load("app/lib/portal-access");
    const before = h.sqlite.prepare("SELECT total_changes() AS count").get().count;
    assert.equal((await getPortalAccess(owner, "admin")).allowed, true);
    assert.equal((await getPortalAccess(owner, "teacher")).allowed, true);
    assert.deepEqual(await getPortalAccess(null, "admin"), { allowed: false, reason: "anonymous" });
    assert.deepEqual(await getPortalAccess(teacher, "admin"), { allowed: false, reason: "wrong-role" });
    const teacherAccess = await getPortalAccess(teacher, "teacher");
    assert.equal(teacherAccess.allowed, true);
    assert.equal(teacherAccess.role, "teacher");
    assert.deepEqual(await getPortalAccess({ ...teacher, memberId: "unknown-member", email: "unknown@elitelac.com", userId: "google:unknown-user" }, "teacher"), { allowed: false, reason: "membership" });
    assert.equal(h.sqlite.prepare("SELECT total_changes() AS count").get().count, before);
    assert.equal(h.sqlite.prepare("SELECT linked_user_id FROM app_users WHERE id = ?").get(invited.id).linked_user_id, null);
    h.state.identity = teacher;
    await h.call("data");
    assert.deepEqual(await getPortalAccess({ ...teacher, memberId: "nonexistent-member" }, "teacher"), { allowed: false, reason: "membership" });
    h.state.identity = owner;
    await h.call("users/[id]", "PATCH", { status: "disabled" }, invited.id);
    assert.deepEqual(await getPortalAccess(teacher, "teacher"), { allowed: false, reason: "disabled" });
    assert.deepEqual(await getPortalAccess(teacher, "admin"), { allowed: false, reason: "disabled" });
  } finally { h.close(); }
});

test("a portal visit cannot bootstrap an unknown visitor as administrator", async () => {
  const h = await harness({ seedOwner: false });
  const { owner, teacher } = h;
  try {
    const { getPortalAccess } = h.load("app/lib/portal-access");
    assert.deepEqual(await getPortalAccess(owner, "admin"), { allowed: false, reason: "membership" });
    assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM app_users").get().count, 0);
  } finally { h.close(); }
});

test("Google admission bootstraps only the configured verified initial administrator", async () => {
  const h = await harness({ seedOwner: false });
  const { owner, teacher } = h;
  try {
    h.state.previewAllowed = false;
    const { resolveVerifiedGoogleMember, requireStaffMembership } = h.load("app/lib/reflection-membership");
    await assert.rejects(() => resolveVerifiedGoogleMember({ subject: "outside-sub", email: "t-wiam-zahri@elitelac.com.other.example", name: "Outside" }), /school Google/);
    assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM app_users").get().count, 0);
    const profile = { subject: "initial-admin-sub", email: "t-wiam-zahri@elitelac.com", name: "Initial School Admin" };
    const admitted = await Promise.all([resolveVerifiedGoogleMember(profile), resolveVerifiedGoogleMember(profile)]);
    assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM app_users").get().count, 1);
    assert.equal(admitted[0].memberId, admitted[1].memberId);
    assert.equal(admitted[0].role, "admin");
    assert.equal(admitted[0].userId, "google:initial-admin-sub");
    assert.equal(h.sqlite.prepare("SELECT linked_user_id FROM app_users").get().linked_user_id, null);
    await assert.rejects(() => requireStaffMembership({ ...profile, userId: "google:initial-admin-sub", displayName: profile.name, fullName: profile.name, authSource: "google" }), /not linked/);
    await assert.rejects(() => requireStaffMembership({ ...owner, authSource: "chatgpt" }), /school Google/);
    const admittedSession = await requireStaffMembership({ ...admitted[0], authSource: "google" });
    assert.equal(admittedSession.memberId, admitted[0].memberId);
  } finally { h.close(); }
});

test("Google admission adds new verified school accounts as teachers but never revives removed staff", async () => {
  const h = await harness();
  try {
    h.state.previewAllowed = false;
    const { resolveVerifiedGoogleMember } = h.load("app/lib/reflection-membership");
    const profile = { subject: "new-teacher-sub", email: "New.Teacher@elitelac.com", name: "New Teacher" };
    const admitted = await Promise.all([resolveVerifiedGoogleMember(profile), resolveVerifiedGoogleMember(profile)]);
    assert.equal(admitted[0].memberId, admitted[1].memberId);
    assert.equal(admitted[0].role, "teacher");
    const row = h.sqlite.prepare("SELECT email, role, status FROM app_users WHERE id = ?").get(admitted[0].memberId);
    assert.deepEqual({ ...row }, { email: "new.teacher@elitelac.com", role: "teacher", status: "active" });
    await assert.rejects(() => resolveVerifiedGoogleMember({ subject: "gmail-sub", email: "someone@gmail.com", name: "Outside" }), /school Google/);
    h.sqlite.prepare("UPDATE app_users SET status='disabled' WHERE id = ?").run(admitted[0].memberId);
    await assert.rejects(() => resolveVerifiedGoogleMember(profile), /disabled/);
    h.sqlite.prepare("UPDATE app_users SET deleted_at='2026-10-23' WHERE id = ?").run(admitted[0].memberId);
    await assert.rejects(() => resolveVerifiedGoogleMember(profile), /disabled/);
    assert.equal(h.sqlite.prepare("SELECT count(*) AS count FROM app_users WHERE email = 'new.teacher@elitelac.com'").get().count, 1);
  } finally { h.close(); }
});

test("Google membership uses the trusted bound member and preserves legacy identity links and stored roles", async () => {
  const h = await harness();
  const { owner, teacher } = h;
  try {
    h.state.previewAllowed = false;
    h.sqlite.prepare("INSERT INTO app_users (id,email,name,role,status,linked_user_id,created_at) VALUES (?,?,?,?,?,?,?)")
      .run("school-teacher", "teacher@elitelac.com", "School Teacher", "teacher", "active", "legacy-chatgpt-id", "2026-10-22");
    const { resolveVerifiedGoogleMember, requireStaffMembership } = h.load("app/lib/reflection-membership");
    const profile = { subject: "school-teacher-sub", email: "teacher@elitelac.com", name: "Provider Name" };
    const admitted = await resolveVerifiedGoogleMember(profile);
    assert.equal(admitted.memberId, "school-teacher");
    assert.equal(admitted.role, "teacher");
    const session = { ...admitted, authSource: "google" };
    assert.equal((await requireStaffMembership(session)).role, "teacher");
    const { getPortalAccess } = h.load("app/lib/portal-access");
    assert.deepEqual(await getPortalAccess(session, "admin"), { allowed: false, reason: "wrong-role" });
    assert.equal((await getPortalAccess(session, "teacher")).allowed, true);
    assert.equal(h.sqlite.prepare("SELECT linked_user_id FROM app_users WHERE id = 'school-teacher'").get().linked_user_id, "legacy-chatgpt-id");
    // A changed email for a trusted, already-linked provider subject cannot promote its role.
    assert.equal((await resolveVerifiedGoogleMember({ ...profile, email: "t-wiam-zahri@elitelac.com" }, "school-teacher")).role, "teacher");
    h.sqlite.prepare("UPDATE app_users SET status='disabled' WHERE id='school-teacher'").run();
    await assert.rejects(() => resolveVerifiedGoogleMember(profile, "school-teacher"), /disabled/);
    await assert.rejects(() => requireStaffMembership(session), /disabled/);
    assert.deepEqual(await getPortalAccess(session, "teacher"), { allowed: false, reason: "disabled" });
  } finally { h.close(); }
});

test("deleting staff removes access and sessions, hides the account and preserves its reflection history", async () => {
  const h = await harness();
  try {
    const invited = await inviteTeacher(h);
    await h.call("students", "POST", { source: "Manual entry", students: [{ name: "History Pupil", grade: "Year 7", className: "7A" }] });
    const pupil = (await h.call("data")).data.students[0];
    h.state.identity = h.teacher;
    await h.call("assignments", "POST", { reasonCategory: "disruption", studentIds: [pupil.id], date: "2026-10-22", slots: ["lunch"], behaviourSteps, assignedBy: "Forged name" });
    const assignment = (await h.call("data")).data.assignments[0];
    await h.call("assignments/[id]", "PATCH", { status: "present" }, assignment.id);
    h.sqlite.prepare("INSERT INTO staff_google_identities(subject,member_id,email,created_at,last_authenticated_at) VALUES(?,?,?,?,?)")
      .run("test-teacher-sub", invited.id, invited.email, 1, 1);
    h.sqlite.prepare("INSERT INTO staff_sessions(token_hash,member_id,google_subject,created_at,expires_at) VALUES(?,?,?,?,?)")
      .run("test-session-hash", invited.id, "test-teacher-sub", 1, Date.now() + 10000);
    h.state.identity = h.owner;
    assert.equal((await h.call("users/[id]", "DELETE", {}, invited.id)).status, 200);
    const tombstone = h.sqlite.prepare("SELECT * FROM app_users WHERE id = ?").get(invited.id);
    assert.equal(tombstone.status, "disabled");
    assert.ok(tombstone.deleted_at.endsWith("Z"));
    assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM staff_sessions WHERE member_id = ?").get(invited.id).n, 0);
    assert.equal((await h.call("users")).data.users.some(row => row.id === invited.id), false);
    const data = (await h.call("data")).data;
    assert.equal(data.users.some(row => row.id === invited.id), false);
    assert.equal(data.assignments.length, 1);
    assert.equal(data.assignments[0].assignedBy, "Verified Teacher");
    assert.equal(data.assignments[0].attendanceRecordedBy, "Verified Teacher");
    assert.equal(data.assignments[0].status, "present");
    assert.equal((await h.call("users/[id]", "PATCH", { status: "active" }, invited.id)).status, 404);
    assert.equal((await h.call("users/[id]", "DELETE", {}, invited.id)).status, 404);
    const reinvite = await h.call("users", "POST", { name: "Another Name", email: invited.email, role: "admin" });
    assert.equal(reinvite.status, 409);
    assert.match(reinvite.data.error, /deleted staff account/);
    h.state.identity = h.teacher;
    assert.equal((await h.call("data")).status, 403);
    const { resolveVerifiedGoogleMember } = h.load("app/lib/reflection-membership");
    await assert.rejects(() => resolveVerifiedGoogleMember({ subject: "test-teacher-sub", email: invited.email, name: invited.name }, invited.id), /disabled/);
    assert.deepEqual(await h.load("app/lib/portal-access").getPortalAccess(h.teacher, "teacher"), { allowed: false, reason: "disabled" });
    const audit = h.sqlite.prepare("SELECT * FROM activity_events WHERE action='staff.deleted'").all();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor_id, h.owner.memberId);
    assert.equal(audit[0].target_name, "Verified Teacher");
  } finally { h.close(); }
});

test("staff deletion rejects teachers, self deletion and the final administrator after an intervening change", async () => {
  const h = await harness();
  try {
    await inviteTeacher(h);
    h.state.identity = h.teacher;
    assert.equal((await h.call("users/[id]", "DELETE", {}, h.owner.memberId)).status, 403);
    h.state.identity = h.owner;
    assert.equal((await h.call("users/[id]", "DELETE", {}, h.owner.memberId)).status, 409);
    const other = (await h.call("users", "POST", { name: "Other Admin", email: "other.admin@elitelac.com", role: "admin" })).data.user;
    h.state.beforeQuery = query => {
      if (query.startsWith('update "app_users" set "status"')) {
        h.state.beforeQuery = null;
        h.sqlite.prepare("UPDATE app_users SET role='teacher' WHERE id=?").run(h.owner.memberId);
      }
    };
    assert.equal((await h.call("users/[id]", "DELETE", {}, other.id)).status, 409);
    assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM app_users WHERE role='admin' AND status='active' AND deleted_at IS NULL").get().n, 1);
    assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM activity_events WHERE action='staff.deleted'").get().n, 0);
  } finally { h.close(); }
});

test("two administrators cannot concurrently delete every active administrator", async () => {
  const h = await harness();
  try {
    const other = (await h.call("users", "POST", { name: "Other Admin", email: "other.admin@elitelac.com", role: "admin" })).data.user;
    const first = h.call("users/[id]", "DELETE", {}, other.id);
    h.state.identity = { authSource: "google", memberId: other.id, userId: "google:other-admin", email: other.email, displayName: other.name, fullName: other.name };
    const second = h.call("users/[id]", "DELETE", {}, h.owner.memberId);
    const results = await Promise.all([first, second]);
    assert.equal(results.filter(result => result.status === 200).length, 1);
    assert.ok(results.some(result => result.status === 403 || result.status === 409));
    assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM app_users WHERE role='admin' AND status='active' AND deleted_at IS NULL").get().n, 1);
    assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM activity_events WHERE action='staff.deleted'").get().n, 1);
  } finally { h.close(); }
});

test("activity is administrator-only and records trusted actors across the reflection and pupil workflow", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-22T12:00:00Z") });
  const h = await harness();
  try {
    const teacher = await inviteTeacher(h);
    await h.call("users/[id]", "PATCH", { name: "Confirmed Teacher" }, teacher.id);
    await h.call("students", "POST", { source: "Manual entry", students: [{ name: "Audit Pupil", grade: "Year 7", className: "7A" }] });
    const pupil = (await h.call("data")).data.students[0];
    await h.call("students/[id]", "PATCH", { className: "7B" }, pupil.id);
    h.state.identity = h.teacher;
    assert.equal((await h.call("activity")).status, 403);
    await h.call("assignments", "POST", { reasonCategory: "disruption", studentIds: [pupil.id], date: "2026-10-22", slots: ["lunch"], behaviourSteps, assignedBy: "Forged actor", actorId: "forged" });
    const original = (await h.call("data")).data.assignments[0];
    assert.equal(original.assignedBy, "Confirmed Teacher");
    const absent = await h.call("assignments/[id]", "PATCH", { status: "absent", actorName: "Forged actor" }, original.id);
    assert.equal(absent.status, 200);
    assert.equal(absent.data.followUp.date, "2026-10-26");
    await h.call("assignments/[id]", "DELETE", {}, absent.data.followUp.id);
    h.state.identity = h.owner;
    await h.call("students/[id]", "DELETE", {}, pupil.id);
    const response = await h.call("activity");
    assert.equal(response.status, 200);
    assert.equal(response.data.limit, 300);
    const events = response.data.events;
    assert.deepEqual(new Set(events.map(event => event.action)), new Set(["staff.created", "staff.updated", "student.created", "student.updated", "student.archived", "reflection.assigned", "attendance.recorded", "reflection.auto_rescheduled", "reflection.auto_extra", "reflection.cancelled"]));
    assert.ok(events.every(event => event.createdAt.endsWith("Z") && !event.actorName.includes("Forged")));
    const teacherEvents = events.filter(event => event.targetType === "reflection");
    assert.ok(teacherEvents.every(event => event.actorId === teacher.id && event.actorName === "Confirmed Teacher" && event.targetName === "Audit Pupil"));
    assert.deepEqual(events.map(event => event.createdAt), events.map(event => event.createdAt).sort().reverse());
    const before = events.length;
    assert.equal((await h.call("assignments/[id]", "DELETE", {}, "missing-reflection")).status, 404);
    assert.equal((await h.call("users/[id]", "DELETE", {}, h.owner.memberId)).status, 409);
    assert.equal((await h.call("activity")).data.events.length, before);
    h.state.identity = null;
    assert.equal((await h.call("activity")).status, 401);
  } finally { h.close(); }
});

test("an audit persistence failure rolls back the corresponding account, pupil and attendance mutations", async () => {
  const h = await harness();
  const originalError = console.error;
  try {
    const fixture = await missedFixture(h);
    h.state.identity = h.owner;
    h.sqlite.exec("CREATE TRIGGER reject_test_audit BEFORE INSERT ON activity_events BEGIN SELECT RAISE(ABORT, 'test audit unavailable'); END");
    console.error = () => {};
    assert.equal((await h.call("users", "POST", { name: "Rollback Teacher", email: "rollback@elitelac.com", role: "teacher" })).status, 500);
    assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM app_users WHERE email='rollback@elitelac.com'").get().n, 0);
    assert.equal((await h.call("students/[id]", "PATCH", { name: "Rolled Back Name" }, fixture.pupil.id)).status, 500);
    assert.notEqual(h.sqlite.prepare("SELECT name FROM students WHERE id=?").get(fixture.pupil.id).name, "Rolled Back Name");
    assert.equal((await h.call("assignments/[id]", "PATCH", { status: "present" }, fixture.source.id)).status, 500);
    assert.equal(h.sqlite.prepare("SELECT status FROM reflection_assignments WHERE id=?").get(fixture.source.id).status, "absent");
  } finally { console.error = originalError; h.close(); }
});

test("activity returns the newest bounded page and roster imports are logged without fabricating earlier events", async () => {
  const h = await harness();
  try {
    assert.deepEqual((await h.call("activity")).data.events, []);
    await h.call("students", "POST", { source: "Test CSV", students: [{ name: "Imported Pupil", grade: "Year 7", className: "7A" }] });
    const imported = (await h.call("activity")).data.events[0];
    assert.equal(imported.action, "roster.imported");
    assert.equal(imported.targetName, "Test CSV");
    assert.equal(imported.actorId, h.owner.memberId);
    const insert = h.sqlite.prepare("INSERT INTO activity_events(id,actor_id,actor_name,action,target_type,target_id,target_name,details,created_at) VALUES(?,?,?,?,?,?,?,?,?)");
    for (let i = 0; i < 305; i++) {
      insert.run(`event-${String(i).padStart(3, "0")}`, h.owner.memberId, "Test Admin", "student.updated", "student", "test-pupil", "Test Pupil", "Updated class", new Date(Date.UTC(2030, 0, 1, 0, 0, i)).toISOString());
    }
    const response = await h.call("activity");
    assert.equal(response.data.events.length, 300);
    assert.equal(response.data.events[0].id, "event-304");
    assert.equal(response.data.events.at(-1).id, "event-005");
    assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM activity_events").get().n, 306);
  } finally { h.close(); }
});

test("moderators use teacher operations and insights but cannot read or mutate administrator management", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-23T12:00:00Z") });
  const h = await harness();
  try {
    const created = await h.call("users", "POST", { name: "School Moderator", email: "moderator@elitelac.com", role: "moderator" });
    assert.equal(created.status, 200);
    const moderator = { authSource: "google", memberId: created.data.user.id, userId: "google:moderator-subject", email: created.data.user.email, displayName: "Untrusted Moderator Name", fullName: null };
    await h.call("students", "POST", { source: "Manual entry", students: [{ name: "Moderated Pupil", grade: "Year 8", className: "8A" }] });
    const pupil = (await h.call("data")).data.students[0];
    h.state.identity = moderator;
    const workspace = await h.call("data");
    assert.equal(workspace.status, 200);
    assert.equal(workspace.data.user.role, "moderator");
    assert.equal("users" in workspace.data, false);
    for (const [route, method, body, id] of [
      ["users", "GET"], ["activity", "GET"],
      ["users", "POST", { name: "Hidden Admin", email: "hidden@elitelac.com", role: "admin" }],
      ["users/[id]", "PATCH", { role: "admin" }, moderator.memberId],
      ["users/[id]", "DELETE", {}, h.owner.memberId],
      ["students", "POST", { source: "Manual entry", students: [{ name: "Unauthorized Pupil", grade: "Year 8", className: "8B" }] }],
      ["students/[id]", "PATCH", { name: "Unauthorized Name" }, pupil.id],
      ["students/[id]", "DELETE", {}, pupil.id],
    ]) assert.equal((await h.call(route, method, body, id)).status, 403, `${method} ${route}`);
    assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM app_users").get().n, 2);
    assert.equal(h.sqlite.prepare("SELECT name,active FROM students WHERE id=?").get(pupil.id).name, "Moderated Pupil");
    assert.equal(h.sqlite.prepare("SELECT active FROM students WHERE id=?").get(pupil.id).active, 1);
    assert.equal((await h.call("insights")).status, 200);
    const assignment = { reasonCategory: "disruption", studentIds: [pupil.id], date: "2026-10-22", slots: ["lunch"], behaviourSteps, assignedBy: "Spoofed admin" };
    assert.equal((await h.call("assignments", "POST", assignment)).status, 200);
    const original = (await h.call("data")).data.assignments[0];
    assert.equal(original.assignedBy, "School Moderator");
    const absent = await h.call("assignments/[id]", "PATCH", { status: "absent" }, original.id);
    assert.equal(absent.status, 200);
    assert.equal(absent.data.followUp.date, "2026-10-26");
    assert.equal((await h.call("assignments/[id]", "DELETE", {}, absent.data.followUp.id)).status, 200);
    h.state.identity = h.owner;
    const logs = (await h.call("activity")).data.events.filter(event => event.actorId === moderator.memberId);
    assert.deepEqual(new Set(logs.map(event => event.action)), new Set(["reflection.assigned", "attendance.recorded", "reflection.auto_rescheduled", "reflection.auto_extra", "reflection.cancelled"]));
    assert.ok(logs.every(event => event.actorName === "School Moderator"));
  } finally { h.close(); }
});

test("all three roles follow their exact portal matrix without changing stored access", async () => {
  const h = await harness();
  try {
    await inviteTeacher(h);
    const member = (await h.call("users", "POST", { name: "Portal Moderator", email: "portal.moderator@elitelac.com", role: "moderator" })).data.user;
    const moderator = { ...h.teacher, memberId: member.id, email: member.email, userId: "google:portal-moderator" };
    const getAccess = h.load("app/lib/portal-access").getPortalAccess;
    const before = h.sqlite.prepare("SELECT total_changes() AS n").get().n;
    for (const [identity, allowed] of [[h.owner, ["admin", "teacher", "moderator"]], [h.teacher, ["teacher"]], [moderator, ["teacher", "moderator"]]]) {
      for (const portal of ["admin", "teacher", "moderator"]) {
        const response = await getAccess(identity, portal);
        assert.equal(response.allowed, allowed.includes(portal), `${identity.email} ${portal}`);
        if (!response.allowed) assert.equal(response.reason, "wrong-role");
      }
    }
    assert.equal(h.sqlite.prepare("SELECT total_changes() AS n").get().n, before);
    h.sqlite.prepare("UPDATE app_users SET status='disabled' WHERE id=?").run(member.id);
    assert.deepEqual(await getAccess(moderator, "moderator"), { allowed: false, reason: "disabled" });
    h.state.identity = moderator;
    assert.equal((await h.call("insights")).status, 403);
  } finally { h.close(); }
});

test("insights attribute exact identities, preserve historical staff and omit operational and account secrets", async () => {
  const h = await harness();
  try {
    const putStaff = h.sqlite.prepare("INSERT INTO app_users(id,email,name,role,status,linked_user_id,created_at,deleted_at) VALUES(?,?,?,?,?,?,?,?)");
    for (const row of [
      ["linked-teacher", "linked.secret@elitelac.com", "Shared Teacher Name", "teacher", "active", "legacy-linked-secret", "2026-10-22", null],
      ["google-teacher", "google.secret@elitelac.com", "Renamed Teacher", "teacher", "active", null, "2026-10-22", null],
      ["zero-teacher", "zero.secret@elitelac.com", "Shared Teacher Name", "teacher", "active", null, "2026-10-22", null],
      ["disabled-teacher", "disabled.secret@elitelac.com", "Disabled Teacher", "teacher", "disabled", null, "2026-10-22", null],
      ["deleted-teacher", "deleted.secret@elitelac.com", "Removed Teacher", "teacher", "disabled", "deleted-linked-secret", "2026-10-22", "2026-10-23"],
      ["zero-moderator", "moderator.secret@elitelac.com", "Teacher Moderator", "moderator", "active", null, "2026-10-22", null],
      ["deleted-zero", "removed.zero@elitelac.com", "Removed Unused Account", "teacher", "disabled", null, "2026-10-22", "2026-10-23"],
    ]) putStaff.run(...row);
    h.sqlite.prepare("INSERT INTO staff_google_identities(subject,member_id,email,created_at,last_authenticated_at) VALUES(?,?,?,?,?)")
      .run("provider-subject-secret", "google-teacher", "google.secret@elitelac.com", 1, 1);
    h.sqlite.prepare("UPDATE app_users SET linked_user_id=? WHERE id=?").run(h.owner.userId, h.owner.memberId);
    h.sqlite.prepare("INSERT INTO students(id,name,grade,class_name,roster_key,toddle_id,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run("insight-pupil", "Insight Pupil", "Year 8", "8A", "private-roster-key", "private-toddle-id", 1, "2026-10-22", "2026-10-22");
    const putReflection = h.sqlite.prepare("INSERT INTO reflection_assignments(id,student_id,date,slot,reason,assigned_by,status,created_at,updated_at,created_by_user_id,updated_by_user_id,rescheduled_from_id,cancelled_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
    let counter = 0;
    const add = (id, creator, name, source = null, cancelled = null) => {
      counter++;
      putReflection.run(id, "insight-pupil", `2026-11-${String(counter).padStart(2, "0")}`, "morning", "Private reflection reason", name, source ? "pending" : "absent", "2026-10-22", "2026-10-22", creator, "private-updater", source, cancelled);
    };
    add("linked-record", "legacy-linked-secret", "Previous Teacher Name");
    add("google-record", "google:provider-subject-secret", "Previous Google Name");
    add("replacement-record", "google:provider-subject-secret", "Renamed Teacher", "google-record");
    add("deleted-record", "deleted-linked-secret", "Previous Removed Name");
    add("admin-record", h.owner.userId, "School Administrator");
    add("unknown-a", "unknown-creator-secret-a", "Shared Teacher Name");
    add("unknown-b", "unknown-creator-secret-b", "Shared Teacher Name");
    add("unknown-a-again", "unknown-creator-secret-a", "Renamed Historical Staff");
    add("cancelled-record", "legacy-linked-secret", "Previous Teacher Name", null, "2026-10-23");
    const response = await h.call("insights");
    assert.equal(response.status, 200);
    const result = response.data;
    assert.deepEqual(Object.keys(result).sort(), ["assignments", "students", "teachers", "user"]);
    assert.deepEqual(Object.keys(result.students[0]).sort(), ["active", "className", "grade", "id", "name"]);
    assert.equal(result.assignments.length, 8);
    for (const assignment of result.assignments) assert.deepEqual(Object.keys(assignment).sort(), ["assignedBy", "createdAt", "date", "id", "reasonCategory", "rescheduledFromId", "rescheduledToId", "slot", "status", "studentId", "teacherId"]);
    for (const teacher of result.teachers) assert.deepEqual(Object.keys(teacher).sort(), ["deleted", "id", "name", "role", "status"]);
    const reflection = id => result.assignments.find(assignment => assignment.id === id);
    assert.equal(reflection("linked-record").teacherId, "linked-teacher");
    assert.equal(reflection("google-record").teacherId, "google-teacher");
    assert.equal(reflection("replacement-record").teacherId, "google-teacher");
    assert.equal(reflection("google-record").rescheduledToId, "replacement-record");
    assert.equal(reflection("replacement-record").rescheduledFromId, "google-record");
    assert.equal(reflection("deleted-record").teacherId, "deleted-teacher");
    assert.equal(reflection("admin-record").teacherId, h.owner.memberId);
    assert.match(reflection("unknown-a").teacherId, /^historical_[0-9a-f]{64}$/);
    assert.notEqual(reflection("unknown-a").teacherId, reflection("unknown-b").teacherId);
    assert.equal(reflection("unknown-a").teacherId, reflection("unknown-a-again").teacherId);
    assert.notEqual(reflection("unknown-a").teacherId, "linked-teacher");
    const teachers = new Map(result.teachers.map(teacher => [teacher.id, teacher]));
    assert.equal(teachers.get("google-teacher").name, "Renamed Teacher");
    assert.equal(teachers.get("deleted-teacher").deleted, true);
    assert.equal(teachers.get("disabled-teacher").status, "disabled");
    assert.ok(teachers.has("zero-teacher"));
    assert.ok(teachers.has("zero-moderator"));
    assert.equal(teachers.has("deleted-zero"), false);
    assert.equal(teachers.get(reflection("unknown-a").teacherId).role, "historical");
    const serialized = JSON.stringify(result);
    for (const secret of ["Private reflection reason", "private-toddle-id", "private-roster-key", "provider-subject-secret", "legacy-linked-secret", "unknown-creator-secret", "linked.secret@", "google.secret@", "private-updater"]) assert.ok(!serialized.includes(secret), secret);
    const again = (await h.call("insights")).data;
    assert.equal(again.assignments.find(assignment => assignment.id === "unknown-a").teacherId, reflection("unknown-a").teacherId);
    h.state.identity = { ...h.teacher, memberId: "google-teacher", email: "google.secret@elitelac.com" };
    assert.equal((await h.call("insights")).status, 403);
    h.state.identity = null;
    assert.equal((await h.call("insights")).status, 401);
  } finally { h.close(); }
});

test("ambiguous historical identity links never guess an account from a name", async () => {
  const h = await harness();
  try {
    const { insightAttribution } = h.load("app/lib/reflection-insights");
    const staff = [
      { id: "member-one", name: "Same Name", role: "teacher", status: "active", deletedAt: null, linkedUserId: "google:ambiguous-subject" },
      { id: "member-two", name: "Same Name", role: "teacher", status: "active", deletedAt: null, linkedUserId: null },
    ];
    const source = { id: "ambiguous-reflection", studentId: "pupil", date: "2026-10-23", slot: "morning", status: "pending", assignedBy: "Same Name", createdAt: "2026-10-23", rescheduledFromId: null, createdByUserId: "google:ambiguous-subject" };
    const response = await insightAttribution([source], staff, [{ subject: "ambiguous-subject", memberId: "member-two" }]);
    assert.match(response.assignments[0].teacherId, /^historical_[0-9a-f]{64}$/);
    const anonymous = await insightAttribution([
      { ...source, id: "empty-one", createdByUserId: "", assignedBy: "private.account@elitelac.com" },
      { ...source, id: "empty-two", createdByUserId: "", assignedBy: "private.account@elitelac.com" },
    ], [], []);
    assert.notEqual(anonymous.assignments[0].teacherId, anonymous.assignments[1].teacherId);
    assert.ok(anonymous.teachers.every(teacher => teacher.name === "Historical staff"));
    assert.ok(!JSON.stringify(anonymous).includes("private.account@"));
  } finally { h.close(); }
});
