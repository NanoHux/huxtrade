import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { pool } from "./index.js";

const directory = fileURLToPath(new URL("../migrations", import.meta.url));
await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
)`);
const applied = new Set((await pool.query<{ name:string }>("SELECT name FROM schema_migrations")).rows.map((row) => row.name));
for (const name of (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort()) {
  if (applied.has(name)) continue;
  const sql = await readFile(join(directory, name), "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations(name) VALUES($1)", [name]);
    await client.query("COMMIT");
    console.log(`applied ${name}`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
console.log("database migrations complete");
await pool.end();
