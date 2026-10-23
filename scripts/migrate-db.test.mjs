import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { initializeDatabase, inspectMigrationTarget } from "./migrate-db.mjs";

const checkedInFolder = fileURLToPath(new URL("../drizzle/", import.meta.url));
const checkedInJournal = JSON.parse(readFileSync(path.join(checkedInFolder, "meta/_journal.json"), "utf8"));

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "reflection-schema-test-"));
  const client = createClient({ url: `file:${path.join(directory, "fixture.sqlite")}` });
  return { client, directory, close() { client.close(); rmSync(directory, { recursive: true, force: true }); } };
}

function migrationHistory(directory, extraSql, entryCount = checkedInJournal.entries.length) {
  const migrationsFolder = path.join(directory, "migrations");
  mkdirSync(path.join(migrationsFolder, "meta"), { recursive: true });
  const entries = checkedInJournal.entries.slice(0, entryCount).map(entry => ({ ...entry }));
  for (const entry of entries) writeFileSync(path.join(migrationsFolder, `${entry.tag}.sql`), readFileSync(path.join(checkedInFolder, `${entry.tag}.sql`)));
  if (extraSql) {
    const tag = `${String(entries.length).padStart(4, "0")}_migration_fixture`;
    entries.push({ idx: entries.length, version: "6", when: entries.at(-1).when + 1, tag, breakpoints: true });
    writeFileSync(path.join(migrationsFolder, `${tag}.sql`), extraSql);
  }
  writeFileSync(path.join(migrationsFolder, "meta/_journal.json"), JSON.stringify({ ...checkedInJournal, entries }));
  return migrationsFolder;
}

async function seed(client) {
  await client.execute("INSERT INTO app_users(id,email,name,role,status,created_at) VALUES ('staff-fixture','fixture@elitelac.com','Fixture Teacher','teacher','active','2026-10-22')");
  await client.execute("INSERT INTO students(id,name,grade,class_name,roster_key,toddle_id,created_at,updated_at) VALUES ('pupil-fixture','Fixture Pupil','Year 3','Year3B','toddle:fixture','fixture','2026-10-22','2026-10-22')");
  await client.execute("INSERT INTO roster_metadata VALUES ('latest','fixture','2026-10-22',1,'staff-fixture')");
  await client.execute("INSERT INTO reflection_assignments(id,student_id,date,slot,assigned_by,status,created_at,updated_at,created_by_user_id,updated_by_user_id,attendance_recorded_by,attendance_recorded_at) VALUES ('absence-fixture','pupil-fixture','2026-10-22','morning','Fixture Teacher','absent','2026-10-22','2026-10-22','staff-fixture','staff-fixture','Fixture Teacher','2026-10-22')");
  await client.execute("INSERT INTO reflection_assignments(id,student_id,date,slot,assigned_by,status,created_at,updated_at,created_by_user_id,updated_by_user_id,rescheduled_from_id) VALUES ('replacement-fixture','pupil-fixture','2026-10-23','lunch','Fixture Teacher','pending','2026-10-22','2026-10-22','staff-fixture','staff-fixture','absence-fixture')");
  await client.execute("INSERT INTO staff_google_identities VALUES ('subject-fixture','staff-fixture','fixture@elitelac.com',1,1)");
  await client.execute("INSERT INTO staff_sessions VALUES ('session-fixture','staff-fixture','subject-fixture',1,2)");
  await client.execute("INSERT INTO staff_oauth_challenges VALUES ('state-fixture','browser-fixture','nonce-fixture','verifier-fixture','teacher',1,2)");
}

const quote = value => `"${value.replaceAll('"', '""')}"`;
async function snapshot(client, prior) {
  const result = {};
  const names = prior ? Object.keys(prior) : (await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations' ORDER BY name")).rows.map(row => row.name);
  for (const name of names) {
    const columns = prior ? prior[name].columns : (await client.execute(`PRAGMA table_info(${quote(name)})`)).rows.map(row => row.name);
    const rows = (await client.execute(`SELECT ${columns.map(quote).join(",")} FROM ${quote(name)}`)).rows.map(row => columns.map(column => row[column])).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    result[name] = { columns, rows };
  }
  return result;
}

test("an empty target is inspect-only until apply and a current target is a no-op", async () => {
  const f = fixture();
  try {
    const inspected = await initializeDatabase(f.client);
    assert.equal(inspected.state, "empty");
    assert.equal(inspected.pendingMigrationCount, checkedInJournal.entries.length);
    assert.equal(inspected.applied, false);
    assert.equal((await f.client.execute("SELECT COUNT(*) AS n FROM sqlite_master")).rows[0].n, 0);
    const initialized = await initializeDatabase(f.client, { apply: true });
    assert.equal(initialized.state, "current");
    assert.equal(initialized.appliedMigrationCount, checkedInJournal.entries.length);
    assert.equal(initialized.pendingMigrationCount, 0);
    assert.deepEqual(initialized.validation, { integrity: "ok", foreignKeys: "ok" });
    const history = await f.client.execute("SELECT * FROM __drizzle_migrations");
    assert.equal((await initializeDatabase(f.client, { apply: true })).applied, false);
    assert.deepEqual((await f.client.execute("SELECT * FROM __drizzle_migrations")).rows, history.rows);
  } finally { f.close(); }
});

test("an exact prefix upgrades atomically and preserves every existing table value and audit link", async () => {
  const f = fixture();
  try {
    await initializeDatabase(f.client, { apply: true });
    await seed(f.client);
    const before = await snapshot(f.client);
    const oldHistory = (await f.client.execute("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at")).rows;
    const migrationsFolder = migrationHistory(f.directory, "ALTER TABLE app_users ADD migration_fixture_note TEXT;\n--> statement-breakpoint\nCREATE TABLE migration_fixture (id INTEGER PRIMARY KEY, owner_id TEXT REFERENCES app_users(id));");
    const pending = await initializeDatabase(f.client, { migrationsFolder });
    assert.equal(pending.state, "pending");
    assert.equal(pending.pendingMigrationCount, 1);
    assert.equal(pending.appliedMigrationCount, oldHistory.length);
    assert.deepEqual(await snapshot(f.client), before);
    const upgraded = await initializeDatabase(f.client, { apply: true, migrationsFolder });
    assert.equal(upgraded.state, "current");
    assert.equal(upgraded.applied, true);
    assert.deepEqual(await snapshot(f.client, before), before);
    assert.deepEqual((await f.client.execute("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at")).rows.slice(0, oldHistory.length), oldHistory);
    assert.equal((await f.client.execute("SELECT migration_fixture_note FROM app_users")).rows[0].migration_fixture_note, null);
    assert.equal((await initializeDatabase(f.client, { apply: true, migrationsFolder })).applied, false);
  } finally { f.close(); }
});

test("a changed recorded hash is rejected without changing application data", async () => {
  const f = fixture();
  try {
    await initializeDatabase(f.client, { apply: true });
    await seed(f.client);
    await f.client.execute("UPDATE __drizzle_migrations SET hash='altered' WHERE created_at=(SELECT MIN(created_at) FROM __drizzle_migrations)");
    const before = await snapshot(f.client);
    await assert.rejects(() => initializeDatabase(f.client, { apply: true }), /history differs/);
    assert.deepEqual(await snapshot(f.client), before);
  } finally { f.close(); }
});

test("missing or unknown journal entries and altered schemas are rejected", async () => {
  for (const modification of [
    "DELETE FROM __drizzle_migrations WHERE created_at=(SELECT MIN(created_at) FROM __drizzle_migrations)",
    "INSERT INTO __drizzle_migrations(hash,created_at) VALUES ('unknown-future-migration',9999999999999)",
    "CREATE TABLE unreviewed_schema (id TEXT)",
    "ALTER TABLE students ADD untracked_column TEXT",
  ]) {
    const f = fixture();
    try {
      await initializeDatabase(f.client, { apply: true });
      await f.client.execute(modification);
      await assert.rejects(() => initializeDatabase(f.client, { apply: true }), /history differs/);
    } finally { f.close(); }
  }
});

test("an untracked nonempty legacy target is never initialized or stamped", async () => {
  const f = fixture();
  try {
    await f.client.execute("CREATE TABLE existing_data (id TEXT PRIMARY KEY)");
    await f.client.execute("INSERT INTO existing_data VALUES ('preserve-me')");
    await assert.rejects(() => initializeDatabase(f.client, { apply: true }), /not empty|history differs/);
    assert.equal((await f.client.execute("SELECT id FROM existing_data")).rows[0].id, "preserve-me");
    assert.equal((await f.client.execute("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='__drizzle_migrations'")).rows[0].n, 0);
  } finally { f.close(); }
});

test("a failed pending migration rolls back earlier SQL and its journal writes", async () => {
  const f = fixture();
  try {
    await initializeDatabase(f.client, { apply: true });
    await seed(f.client);
    const before = await snapshot(f.client);
    const oldHistory = (await f.client.execute("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at")).rows;
    const migrationsFolder = migrationHistory(f.directory, "CREATE TABLE must_rollback (id TEXT);\n--> statement-breakpoint\nUPDATE students SET name='Must roll back';\n--> statement-breakpoint\nINSERT INTO nonexistent_fixture_table VALUES ('fail');");
    await assert.rejects(() => initializeDatabase(f.client, { apply: true, migrationsFolder }));
    assert.deepEqual(await snapshot(f.client), before);
    assert.deepEqual((await f.client.execute("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at")).rows, oldHistory);
    assert.equal((await inspectMigrationTarget(f.client)).state, "current");
    assert.equal((await inspectMigrationTarget(f.client, migrationsFolder)).state, "pending");
  } finally { f.close(); }
});

test("foreign-key violations block migration before any new schema or journal entry", async () => {
  const f = fixture();
  try {
    await initializeDatabase(f.client, { apply: true });
    await seed(f.client);
    await f.client.execute("PRAGMA foreign_keys=OFF");
    await f.client.execute("UPDATE reflection_assignments SET student_id='missing-fixture'");
    await f.client.execute("PRAGMA foreign_keys=ON");
    const migrationsFolder = migrationHistory(f.directory, "CREATE TABLE should_not_exist (id TEXT);");
    await assert.rejects(() => initializeDatabase(f.client, { apply: true, migrationsFolder }), /foreign-key validation/);
    assert.equal((await f.client.execute("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='should_not_exist'")).rows[0].n, 0);
    assert.equal((await f.client.execute("SELECT COUNT(*) AS n FROM __drizzle_migrations")).rows[0].n, checkedInJournal.entries.length);
  } finally { f.close(); }
});

test("moderator access rebuild preserves every old value, identity, session and audit link", async () => {
  const f = fixture();
  try {
    const oldFolder = migrationHistory(f.directory, null, 6);
    await initializeDatabase(f.client, { apply: true, migrationsFolder: oldFolder });
    await seed(f.client);
    await f.client.execute("INSERT INTO app_users VALUES ('admin-fixture','admin@elitelac.com','Existing Admin','admin','active','linked-admin','2026-10-21','2026-10-22',NULL)");
    await f.client.execute("INSERT INTO app_users VALUES ('deleted-fixture','removed@elitelac.com','Removed Teacher','teacher','disabled',NULL,'2026-10-21',NULL,'2026-10-22')");
    await f.client.execute("INSERT INTO activity_events VALUES ('event-fixture','staff-fixture','Fixture Teacher','assignment.attendance','assignment','absence-fixture','Fixture Pupil','Marked absent','2026-10-22')");
    const before = await snapshot(f.client);
    const historyBefore = (await f.client.execute("SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at")).rows;
    const childSchema = (await f.client.execute("SELECT name,sql FROM sqlite_master WHERE name IN ('staff_google_identities','staff_sessions') ORDER BY name")).rows;
    const upgraded = await initializeDatabase(f.client, { apply: true });
    assert.equal(upgraded.applied, true);
    assert.deepEqual(await snapshot(f.client), before);
    assert.deepEqual((await f.client.execute("SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at")).rows.slice(0, 6), historyBefore);
    assert.deepEqual((await f.client.execute("SELECT name,sql FROM sqlite_master WHERE name IN ('staff_google_identities','staff_sessions') ORDER BY name")).rows, childSchema);
    assert.equal((await f.client.execute("PRAGMA foreign_keys")).rows[0].foreign_keys, 1);
    assert.deepEqual((await f.client.execute("PRAGMA foreign_key_check")).rows, []);
    assert.equal((await f.client.execute("SELECT COUNT(*) AS n FROM sqlite_temp_master WHERE name LIKE '__moderator_%'")).rows[0].n, 0);
    await f.client.execute("INSERT INTO app_users(id,email,name,role,created_at) VALUES ('moderator-fixture','moderator@elitelac.com','Fixture Moderator','moderator','2026-10-23')");
    await f.client.execute("INSERT INTO staff_oauth_challenges VALUES ('moderator-state','browser','nonce','verifier','moderator',1,2)");
    await assert.rejects(() => f.client.execute("INSERT INTO app_users(id,email,name,role,created_at) VALUES ('bad','bad@elitelac.com','Bad Role','owner','2026-10-23')"), /CHECK constraint/);
    await assert.rejects(() => f.client.execute("INSERT INTO staff_oauth_challenges VALUES ('bad-state','browser','nonce','verifier','owner',1,2)"), /CHECK constraint/);
    await assert.rejects(() => f.client.execute("INSERT INTO staff_sessions VALUES ('bad-session','missing-member','subject-fixture',1,2)"), /FOREIGN KEY constraint/);
    assert.equal((await initializeDatabase(f.client, { apply: true })).applied, false);
  } finally { f.close(); }
});

test("moderator migration guards roll back altered copied values or broken identity links", async () => {
  for (const injectedSql of [
    "UPDATE app_users SET name='Must roll back' WHERE id='staff-fixture';",
    "DELETE FROM staff_google_identities WHERE subject='subject-fixture';",
    "UPDATE staff_oauth_challenges SET nonce='Must roll back';",
    "UPDATE staff_google_identities SET email='changed@elitelac.com';",
    "DELETE FROM staff_sessions;",
  ]) {
    const f = fixture();
    try {
      const oldFolder = migrationHistory(f.directory, null, 6);
      await initializeDatabase(f.client, { apply: true, migrationsFolder: oldFolder });
      await seed(f.client);
      const before = await snapshot(f.client);
      const historyBefore = (await f.client.execute("SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at")).rows;
      const currentFolder = migrationHistory(f.directory);
      const migrationPath = path.join(currentFolder, "0006_moderator_access.sql");
      const sql = readFileSync(migrationPath, "utf8").replace("INSERT INTO `__moderator_migration_guard`\nSELECT CASE WHEN", `${injectedSql}\n--> statement-breakpoint\nINSERT INTO \`__moderator_migration_guard\`\nSELECT CASE WHEN`);
      writeFileSync(migrationPath, sql);
      await assert.rejects(() => initializeDatabase(f.client, { apply: true, migrationsFolder: currentFolder }), /CHECK constraint/);
      assert.deepEqual(await snapshot(f.client), before);
      assert.deepEqual((await f.client.execute("SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at")).rows, historyBefore);
      assert.equal((await f.client.execute("PRAGMA foreign_keys")).rows[0].foreign_keys, 1);
      assert.deepEqual((await f.client.execute("PRAGMA foreign_key_check")).rows, []);
      assert.equal((await inspectMigrationTarget(f.client)).state, "pending");
    } finally { f.close(); }
  }
});

test("a concurrent WAL reader sees its original consistent snapshot throughout moderator migration", async () => {
  const f = fixture();
  const reader = createClient({ url: `file:${path.join(f.directory, "fixture.sqlite")}` });
  let readTransaction;
  try {
    await f.client.execute("PRAGMA journal_mode=WAL");
    const oldFolder = migrationHistory(f.directory, null, 6);
    await initializeDatabase(f.client, { apply: true, migrationsFolder: oldFolder });
    await seed(f.client);
    const before = await snapshot(f.client);
    readTransaction = await reader.transaction("read");
    assert.equal((await readTransaction.execute("SELECT COUNT(*) AS n FROM app_users")).rows[0].n, 1);
    assert.equal(String((await readTransaction.execute("SELECT sql FROM sqlite_master WHERE name='app_users'")).rows[0].sql).includes("moderator"), false);
    await initializeDatabase(f.client, { apply: true });
    assert.equal(String((await readTransaction.execute("SELECT sql FROM sqlite_master WHERE name='app_users'")).rows[0].sql).includes("moderator"), false);
    assert.equal((await readTransaction.execute("SELECT member_id FROM staff_sessions")).rows[0].member_id, "staff-fixture");
    assert.deepEqual(await snapshot(f.client), before);
    await readTransaction.commit();
    readTransaction = null;
    assert.equal(String((await reader.execute("SELECT sql FROM sqlite_master WHERE name='app_users'")).rows[0].sql).includes("moderator"), true);
    assert.equal((await f.client.execute("PRAGMA journal_mode")).rows[0].journal_mode, "wal");
  } finally { if (readTransaction) await readTransaction.rollback(); reader.close(); f.close(); }
});
