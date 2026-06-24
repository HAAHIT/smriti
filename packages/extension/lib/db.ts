// sql.js wrapper with OPFS persistence.
//
// sql.js gives us full SQLite (including FTS5) running as WebAssembly inside
// the extension's Offscreen Document. OPFS (Origin Private File System) is the
// persistence layer — the DB file lives in the extension's private storage,
// survives restarts, and is never visible to websites.
//
// Persistence strategy: every write schedules a debounced flush to OPFS.
// db.export() on a small DB (<100MB) is <10ms; the 2-second debounce means
// at most one flush per burst of writes rather than one per row.

import type { Database, SqlJsStatic } from "sql.js";
import initSqlJs from "fts5-sql-bundle";
// Vite copies the WASM file to the output and replaces this import with the
// extension-relative URL at build time.
// @ts-ignore — Vite handles the ?url transform
import sqlWasmUrl from "fts5-sql-bundle/dist/sql-wasm.wasm?url";
import { SCHEMA } from "./migrations.js";

const OPFS_FILE = "smriti.db";

let _db: Database | null = null;
let _SQL: SqlJsStatic | null = null;
let _dirty = false;
let _flushTimer: ReturnType<typeof setTimeout> | null = null;

export async function initDb(): Promise<void> {
  // Ask the browser never to evict this origin's storage (OPFS) under disk
  // pressure. Best-effort: extension origins are usually granted silently.
  try {
    const persisted = await navigator.storage.persist();
    console.log("[smriti:db] storage.persist:", persisted ? "granted" : "denied");
  } catch (e) {
    console.warn("[smriti:db] storage.persist unavailable", e);
  }

  _SQL = (await initSqlJs({ locateFile: () => sqlWasmUrl as string })) as unknown as SqlJsStatic;

  // Try to load an existing database from OPFS.
  let existing: Uint8Array | null = null;
  try {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(OPFS_FILE);
    const file = await fh.getFile();
    existing = new Uint8Array(await file.arrayBuffer());
  } catch {
    // File doesn't exist yet — fresh install.
  }

  _db = existing?.length ? new _SQL!.Database(existing) : new _SQL!.Database();
  _db.run("PRAGMA foreign_keys = ON");

  // Apply schema / migrations on every boot (idempotent).
  applySchema(_db);
}

export function getDb(): Database {
  if (!_db) throw new Error("DB not initialized — call initDb() first");
  return _db;
}

// Call after any write to schedule a background flush to OPFS.
export function markDirty(): void {
  _dirty = true;
  if (_flushTimer) clearTimeout(_flushTimer);
  _flushTimer = setTimeout(() => {
    void flushToOpfs();
  }, 2_000);
}

export async function flushToOpfs(): Promise<void> {
  if (!_dirty || !_db) return;
  _dirty = false;
  _flushTimer = null;
  try {
    const data = _db.export();
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(OPFS_FILE, { create: true });
    const writable = await fh.createWritable();
    await writable.write(data as unknown as ArrayBuffer);
    await writable.close();
  } catch (e) {
    console.error("[smriti:db] flush failed", e);
    _dirty = true; // retry on next write
  }
}

// ─── Query helpers ────────────────────────────────────────────────────────────
// Thin wrappers that mimic better-sqlite3's synchronous API so ported code
// reads cleanly. sql.js IS synchronous in the main/offscreen thread — no await.

type Row = Record<string, unknown>;
type BindParams = (string | number | null | Uint8Array)[] | Record<string, unknown>;

export function dbAll<T = Row>(sql: string, params?: BindParams): T[] {
  const db = getDb();
  const stmt = db.prepare(sql);
  try {
    if (params) stmt.bind(params as Parameters<typeof stmt.bind>[0]);
    const rows: T[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject() as T);
    return rows;
  } finally {
    stmt.free();
  }
}

export function dbGet<T = Row>(sql: string, params?: BindParams): T | undefined {
  const db = getDb();
  const stmt = db.prepare(sql);
  try {
    if (params) stmt.bind(params as Parameters<typeof stmt.bind>[0]);
    if (!stmt.step()) return undefined;
    return stmt.getAsObject() as T;
  } finally {
    stmt.free();
  }
}

export function dbRun(sql: string, params?: BindParams): void {
  const db = getDb();
  const stmt = db.prepare(sql);
  try {
    if (params) {
      stmt.run(params as Parameters<typeof stmt.run>[0]);
    } else {
      stmt.run();
    }
  } finally {
    stmt.free();
  }
}

export function dbExec(sql: string): void {
  getDb().run(sql);
}

// ─── Schema application ───────────────────────────────────────────────────────

function applySchema(db: Database): void {
  // Migrations table — idempotent.
  db.run(`CREATE TABLE IF NOT EXISTS _migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);

  const applied = new Set(
    dbAll<{ id: string }>("SELECT id FROM _migrations").map((r) => r.id),
  );

  for (const [id, sql] of SCHEMA) {
    if (applied.has(id)) continue;
    db.run("BEGIN");
    try {
      db.run(sql);
      db.run(
        "INSERT INTO _migrations (id, applied_at) VALUES (?, ?)",
        [id, new Date().toISOString()],
      );
      db.run("COMMIT");
      console.log("[smriti:db] applied migration", id);
    } catch (e) {
      db.run("ROLLBACK");
      throw e;
    }
  }
}
