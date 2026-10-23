import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";

function createDb() {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) {
    throw new Error("The school database is not connected. Configure TURSO_DATABASE_URL and TURSO_AUTH_TOKEN privately.");
  }
  let parsed: URL;
  try { parsed = new URL(url); } catch {
    throw new Error("The school database connection must use a secure remote Turso URL.");
  }
  if (!["libsql:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
    throw new Error("The school database connection must use a secure remote Turso URL.");
  }
  const client = createClient({ url, authToken });
  return drizzle(client, { schema });
}

let database: ReturnType<typeof createDb> | undefined;

// Next.js evaluates server modules during builds. Connect only when a protected
// request actually needs data; missing configuration must never create a local DB.
export function getDb() {
  return database ??= createDb();
}
