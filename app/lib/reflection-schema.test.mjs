import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

function testDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
  const directory = new URL("../../drizzle/", import.meta.url);
  try {
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
      db.exec(readFileSync(new URL(file, directory), "utf8"));
    }
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    db.close();
    throw error;
  }
  db.exec("PRAGMA foreign_keys = ON");
  db.prepare("INSERT INTO students (id, name, grade, class_name, roster_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("test-student", "Test Student", "Grade 7", "7A", "test-key", "2026-10-22", "2026-10-22");
  return db;
}

function addAssignment(db, id, slot = "morning", status = "pending", studentId = "test-student") {
  db.prepare("INSERT INTO reflection_assignments (id, student_id, date, slot, reason, assigned_by, status, created_at, updated_at, created_by_user_id, updated_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, studentId, "2026-10-22", slot, "Test reason", "Test Teacher", status, "2026-10-22", "2026-10-22", "test-user", "test-user");
}

test("migrations allow one morning and one lunch assignment, with no duplicates", () => {
  const db = testDatabase();
  try {
    addAssignment(db, "test-morning", "morning");
    addAssignment(db, "test-lunch", "lunch");
    assert.throws(() => addAssignment(db, "test-duplicate", "morning"), /UNIQUE constraint failed/);
    assert.equal(db.prepare("SELECT count(*) AS count FROM reflection_assignments").get().count, 2);
  } finally {
    db.close();
  }
});

test("database constraints reject invalid slots, attendance, and missing students", () => {
  const db = testDatabase();
  try {
    assert.throws(() => addAssignment(db, "test-bad-slot", "afternoon"), /CHECK constraint failed/);
    assert.throws(() => addAssignment(db, "test-bad-status", "morning", "unknown"), /CHECK constraint failed/);
    assert.throws(() => addAssignment(db, "test-orphan", "morning", "pending", "missing-student"), /FOREIGN KEY constraint failed/);
  } finally {
    db.close();
  }
});

test("soft cancellation preserves the audit record while freeing its session for a new assignment", () => {
  const db = testDatabase();
  try {
    addAssignment(db, "test-cancelled");
    db.prepare("UPDATE reflection_assignments SET cancelled_at = ?, cancelled_by_user_id = ? WHERE id = ?")
      .run("2026-10-22T10:00:00.000Z", "test-user", "test-cancelled");
    assert.equal(db.prepare("SELECT count(*) AS count FROM reflection_assignments WHERE cancelled_at IS NULL").get().count, 0);
    assert.equal(db.prepare("SELECT count(*) AS count FROM reflection_assignments").get().count, 1);
    addAssignment(db, "test-reassigned");
    assert.equal(db.prepare("SELECT count(*) AS count FROM reflection_assignments WHERE cancelled_at IS NULL").get().count, 1);
    assert.equal(db.prepare("SELECT count(*) AS count FROM reflection_assignments").get().count, 2);
  } finally {
    db.close();
  }
});
