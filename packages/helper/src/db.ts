import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dbPath } from "./paths.js";
import { log } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;
  const path = dbPath();
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  dbInstance = db;
  return db;
}

function runMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);

  const applied = new Set(
    db.prepare("SELECT id FROM _migrations").all().map((r) => (r as { id: string }).id),
  );

  // Migrations live alongside the compiled output; for tsx dev they sit next to src.
  const migrationsDir = findMigrationsDir();
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const insertMig = db.prepare("INSERT INTO _migrations (id, applied_at) VALUES (?, ?)");

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    log.info("applying migration", { file });
    const tx = db.transaction(() => {
      db.exec(sql);
      insertMig.run(file, new Date().toISOString());
    });
    tx();
  }
}

function findMigrationsDir(): string {
  // Try sibling "migrations" first (works for both src and dist layouts).
  const candidates = [
    join(__dirname, "migrations"),
    join(__dirname, "..", "src", "migrations"),
  ];
  for (const c of candidates) {
    try {
      readdirSync(c);
      return c;
    } catch {
      /* try next */
    }
  }
  throw new Error("Could not locate migrations directory");
}
