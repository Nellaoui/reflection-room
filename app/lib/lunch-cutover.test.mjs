import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { createTestDatabase } from "./libsql-test-db.mjs";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = new URL("../../", import.meta.url);
const modules = new Map();
function load(relativePath) {
  if (modules.has(relativePath)) return modules.get(relativePath).exports;
  const source = new URL(`${relativePath}.ts`, root);
  const loaded = { exports: {} };
  modules.set(relativePath, loaded);
  const compiled = ts.transpileModule(readFileSync(source, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const localRequire = specifier => specifier.startsWith("@/")
    ? load(specifier.slice(2))
    : specifier.startsWith("./") ? createRequire(source)(specifier) : require(specifier);
  new Function("require", "module", "exports", compiled)(localRequire, loaded, loaded.exports);
  return loaded.exports;
}

const { previewLunchCutover, applyLunchCutover } = load("app/lib/lunch-cutover");
const now = new Date("2026-11-12T09:00:00Z");
const originalTime = "2026-11-03T09:00:00.000Z";
const actor = { memberId: "staff-admin", userId: "google:admin", displayName: "Fixture Admin" };

async function fixture(t) {
  const database = await createTestDatabase();
  t.after(() => database.close());
  const pupil = database.sqlite.prepare(`INSERT INTO students (id, name, grade, class_name, roster_key, created_at, updated_at)
    VALUES (?, ?, 'Year 7', '7A', ?, ?, ?)`);
  pupil.run("pupil-a", "Fixture Student A", "fixture-a", originalTime, originalTime);
  pupil.run("pupil-b", "Fixture Student B", "fixture-b", originalTime, originalTime);
  const insert = database.sqlite.prepare(`INSERT INTO reflection_assignments (
    id, student_id, date, slot, reason, assigned_by, status, created_at, updated_at,
    created_by_user_id, updated_by_user_id, cancelled_at, attendance_recorded_by, attendance_recorded_at, rescheduled_from_id
  ) VALUES (?, ?, ?, ?, ?, 'Fixture Teacher', ?, ?, ?, 'google:teacher', 'google:teacher', ?, ?, ?, ?)`);
  return {
    ...database,
    booking(id, date, { studentId = "pupil-a", slot = "morning", status = "pending", cancelled = false, source = null } = {}) {
      insert.run(id, studentId, date, slot, `Reason for ${id}`, status, originalTime, originalTime,
        cancelled ? originalTime : null, status === "pending" ? null : "Fixture Teacher", status === "pending" ? null : originalTime, source);
    },
    assignments() {
      return database.sqlite.prepare("SELECT * FROM reflection_assignments ORDER BY id").all();
    },
    activity() {
      return database.sqlite.prepare("SELECT * FROM activity_events ORDER BY target_id").all();
    },
  };
}

test("morning cutover cascades around booked lunches and school closures, preserving attendance, attribution and links", async t => {
  const database = await fixture(t);
  database.booking("historical-absence", "2026-11-03", { status: "absent" });
  database.booking("historical-present", "2026-11-04", { status: "present" });
  database.booking("oldest", "2026-11-05", { source: "historical-absence" });
  database.booking("cancelled-morning", "2026-11-11", { cancelled: true });
  database.booking("existing-lunch", "2026-11-12", { slot: "lunch" });
  database.booking("cancelled-lunch", "2026-11-13", { slot: "lunch", cancelled: true });
  database.booking("next", "2026-11-13");
  database.booking("another-lunch", "2026-11-16", { slot: "lunch", status: "present" });
  database.booking("holiday", "2026-11-18");
  database.booking("unrelated-same-day", "2026-11-12", { studentId: "pupil-b" });
  const before = database.assignments();

  const plan = await previewLunchCutover(database.db, now);
  assert.equal(plan.schoolDate, "2026-11-12");
  assert.deepEqual(plan.blocked, []);
  assert.deepEqual(plan.moves.map(move => [move.id, move.fromDate, move.toDate]), [
    ["oldest", "2026-11-05", "2026-11-13"],
    ["unrelated-same-day", "2026-11-12", "2026-11-12"],
    ["next", "2026-11-13", "2026-11-17"],
    ["holiday", "2026-11-18", "2026-11-19"],
  ]);
  assert.deepEqual(database.assignments(), before);
  assert.deepEqual(database.activity(), []);

  const result = await applyLunchCutover(database.db, actor, plan.planId, now);
  assert.equal(result.moved, 4);
  const destinations = new Map(plan.moves.map(move => [move.id, move.toDate]));
  const after = database.assignments();
  for (const [index, previous] of before.entries()) {
    if (!destinations.has(previous.id)) assert.deepEqual(after[index], previous);
    else assert.deepEqual({ ...after[index] }, {
      ...previous,
      date: destinations.get(previous.id), slot: "lunch", updated_at: now.toISOString(), updated_by_user_id: actor.userId,
    });
  }
  const events = database.activity();
  assert.equal(events.length, 4);
  assert.ok(events.every(event => event.actor_id === actor.memberId && event.action === "reflection.rescheduled"));
  assert.equal(events.find(event => event.target_id === "oldest").details, "2026-11-05 · Morning break → 2026-11-13 · Lunch break");
  assert.equal((await applyLunchCutover(database.db, actor, plan.planId, now)).moved, 0);
  assert.deepEqual(database.activity(), events);
});

test("a new lunch reservation invalidates the reviewed cutover plan", async t => {
  const database = await fixture(t);
  database.booking("morning", "2026-11-12");
  const plan = await previewLunchCutover(database.db, now);
  database.booking("lunch", "2026-11-12", { slot: "lunch" });
  await assert.rejects(applyLunchCutover(database.db, actor, plan.planId, now), { status: 409, message: /proposed moves have changed/ });
  assert.equal(database.assignments().find(row => row.id === "morning").slot, "morning");
  assert.equal(database.activity().length, 0);
  assert.equal((await previewLunchCutover(database.db, now)).moves[0].toDate, "2026-11-13");
});

test("the Casablanca school date sets the scheduling floor and expires a plan across midnight", async t => {
  const database = await fixture(t);
  const historical = await previewLunchCutover(database.db, new Date("2026-01-04T23:30:00Z"));
  assert.equal(historical.schoolDate, "2026-01-05");
  database.booking("morning", "2026-11-12");
  const plan = await previewLunchCutover(database.db, new Date("2026-11-12T22:00:00Z"));
  const nextMorning = new Date("2026-11-13T01:00:00Z");
  await assert.rejects(applyLunchCutover(database.db, actor, plan.planId, nextMorning), { status: 409 });
  const refreshed = await previewLunchCutover(database.db, nextMorning);
  assert.equal(refreshed.schoolDate, "2026-11-13");
  assert.equal(refreshed.moves[0].toDate, "2026-11-13");
});

test("calendar exhaustion or an audit failure rolls back every move", async t => {
  const database = await fixture(t);
  database.booking("first", "2026-11-12");
  database.booking("last-day", "2027-06-30");
  database.booking("last-lunch", "2027-06-30", { slot: "lunch" });
  const blocked = await previewLunchCutover(database.db, now);
  assert.deepEqual(blocked.blocked.map(row => row.id), ["last-day"]);
  await assert.rejects(applyLunchCutover(database.db, actor, blocked.planId, now), { status: 409, message: /verified school calendar/ });
  assert.equal(database.assignments().find(row => row.id === "first").slot, "morning");
  assert.equal(database.activity().length, 0);

  database.sqlite.prepare("UPDATE reflection_assignments SET cancelled_at = ? WHERE id = ?").run(originalTime, "last-lunch");
  database.sqlite.exec(`CREATE TRIGGER prevent_fixture_audit BEFORE INSERT ON activity_events
    WHEN NEW.target_id = 'last-day' BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END`);
  const plan = await previewLunchCutover(database.db, now);
  const before = database.assignments();
  await assert.rejects(applyLunchCutover(database.db, actor, plan.planId, now), /fixture audit failure/);
  assert.deepEqual(database.assignments(), before);
  assert.equal(database.activity().length, 0);
});
