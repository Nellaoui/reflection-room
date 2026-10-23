import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { fileURLToPath } from "node:url";
import path from "node:path";

const migrationFolder = fileURLToPath(new URL("../drizzle/", import.meta.url));
const schemaQuery = "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations' ORDER BY type, name";
const historyError = () => new Error("Refusing schema migration: the target is not empty or its migration history differs from an exact checked-in prefix. Review its history manually.");

async function validateDatabase(client) {
  const integrity = (await client.execute("PRAGMA integrity_check")).rows;
  if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") throw new Error("Schema migration failed database integrity validation.");
  if ((await client.execute("PRAGMA foreign_key_check")).rows.length) throw new Error("Schema migration failed foreign-key validation.");
  return { integrity: "ok", foreignKeys: "ok" };
}

function schemaSignature(rows) {
  return JSON.stringify(rows.map(row => [row.type, row.name, row.tbl_name, row.sql == null ? null : String(row.sql).trim()]));
}

// Replaying only the recorded, hash-verified prefix detects a legacy or manually
// changed schema even when a migration journal has been copied onto it.
async function expectedSchema(migrations) {
  const reference = createClient({ url: "file::memory:" });
  try {
    if (migrations.length) await reference.migrate(migrations.flatMap(migration => migration.sql.map(sql => ({ sql, args: [] }))));
    return schemaSignature((await reference.execute(schemaQuery)).rows);
  } finally { reference.close(); }
}

export async function inspectMigrationTarget(client, migrationsFolder = migrationFolder) {
  const migrations = readMigrationFiles({ migrationsFolder });
  if (!migrations.length || migrations.some((migration, index) => !Number.isSafeInteger(migration.folderMillis) || (index && migration.folderMillis <= migrations[index - 1].folderMillis))) {
    throw new Error("Checked-in migration timestamps must be nonempty and strictly increasing.");
  }
  const tables = (await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")).rows.map(row => String(row.name));
  const hasJournal = tables.includes("__drizzle_migrations");
  let recorded = [];
  if (hasJournal) {
    const columns = (await client.execute("PRAGMA table_info('__drizzle_migrations')")).rows.map(row => row.name);
    if (JSON.stringify(columns) !== JSON.stringify(["id", "hash", "created_at"])) throw historyError();
    recorded = (await client.execute("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at")).rows;
  }
  const prefix = recorded.length <= migrations.length && recorded.every((row, index) => row.hash === migrations[index].hash && Number(row.created_at) === migrations[index].folderMillis);
  if (!prefix) throw historyError();
  const actualSchema = schemaSignature((await client.execute(schemaQuery)).rows);
  if (actualSchema !== await expectedSchema(migrations.slice(0, recorded.length))) throw historyError();
  const validation = await validateDatabase(client);
  return {
    state: recorded.length === migrations.length ? "current" : recorded.length ? "pending" : "empty",
    migrationCount: migrations.length,
    appliedMigrationCount: recorded.length,
    pendingMigrationCount: migrations.length - recorded.length,
    pendingMigrations: migrations.slice(recorded.length).map(migration => ({ hash: migration.hash, createdAt: migration.folderMillis })),
    tables,
    validation,
  };
}

export async function initializeDatabase(client, { apply = false, migrationsFolder = migrationFolder } = {}) {
  const before = await inspectMigrationTarget(client, migrationsFolder);
  if (before.state === "current" || !apply) return { ...before, applied: false };
  // Drizzle delegates SQL and journal writes to client.migrate(), which disables
  // foreign keys before BEGIN and restores them after commit or rollback. The
  // moderator table rebuild verifies copied records and foreign keys inside that
  // same transaction, before its journal write. Do not replace this with batch()
  // or in-transaction PRAGMA toggles. Never stamp or replay legacy history.
  await migrate(drizzle(client), { migrationsFolder });
  const after = await inspectMigrationTarget(client, migrationsFolder);
  if (after.state !== "current") throw new Error("Schema migration could not be verified.");
  return { ...after, applied: true };
}

async function main() {
  const flags = process.argv.slice(2);
  if (flags.some(flag => flag !== "--apply")) throw new Error("Usage: npm run db:migrate -- [--apply]. Without --apply, inspect only.");
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) throw new Error("Configure TURSO_DATABASE_URL and TURSO_AUTH_TOKEN privately before migration.");
  const parsed = new URL(url);
  if (!["libsql:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) throw new Error("Expected a secure remote Turso URL.");
  const client = createClient({ url, authToken });
  try {
    const result = await initializeDatabase(client, { apply: flags.includes("--apply") });
    const next = result.state === "empty" ? "Run with --apply to initialize this empty database." : result.state === "pending" ? "Review pending migrations and run with --apply to upgrade this verified database." : "Schema matches all checked-in immutable migrations.";
    console.log(JSON.stringify({ ...result, next }));
  } finally { client.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Provider errors can include URLs or SQL parameters. Do not expose them.
    console.error("Database migration failed. Check the private connection settings and verify that the target is empty or has an exact checked-in migration prefix with a matching schema.");
    process.exitCode = 1;
  });
}
