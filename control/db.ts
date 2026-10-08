import { SQL } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DATABASE_URL } from "./config";

export type Db = SQL;

export function connect(url = DATABASE_URL): Db {
  if (!url) throw new Error("CONTROL_DATABASE_URL is not set");
  return new SQL(url);
}

export async function migrate(sql: Db) {
  await sql.unsafe(readFileSync(join(import.meta.dir, "schema.sql"), "utf8"));
}
