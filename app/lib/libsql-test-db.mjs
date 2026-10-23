// Isolated real-driver transport shared only by backend tests. Never loads env
// files or connects to a remote database.
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createClient } = require("@libsql/client");
const { drizzle } = require("drizzle-orm/libsql");
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

export async function createTestDatabase({ beforeQuery } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "reflection-libsql-test-"));
  const filename = path.join(directory, "test.sqlite");
  const sqlite = new DatabaseSync(filename);
  // Match libSQL migrate's rebuild boundary: suspend FK enforcement before the
  // atomic schema transaction, validate every link, then restore enforcement.
  sqlite.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
  try {
    for (const file of readdirSync(path.join(projectRoot, "drizzle")).filter(name => name.endsWith(".sql")).sort()) {
      sqlite.exec(readFileSync(path.join(projectRoot, "drizzle", file), "utf8"));
    }
    if (sqlite.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Invalid test fixture foreign keys");
    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.exec("ROLLBACK");
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  sqlite.exec("PRAGMA foreign_keys = ON");
  const client = createClient({ url: `file:${filename}` });
  await client.execute("PRAGMA foreign_keys = ON");
  const execute = client.execute.bind(client);
  client.execute = (statement, ...args) => {
    beforeQuery?.(typeof statement === "string" ? statement : statement.sql, typeof statement === "string" ? args[0] || [] : statement.args || []);
    return execute(statement, ...args);
  };
  const batch = client.batch.bind(client);
  client.batch = (statements, ...args) => {
    for (const statement of statements) {
      beforeQuery?.(typeof statement === "string" ? statement : statement.sql, typeof statement === "string" ? [] : statement.args || []);
    }
    return batch(statements, ...args);
  };
  return {
    client, sqlite, db: drizzle(client),
    close() { client.close(); sqlite.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
