import { platform, homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync, copyFileSync } from "node:fs";

// Where Smriti stores its local data.
//   Windows:  %APPDATA%\Smriti
//   macOS:    ~/Library/Application Support/Smriti
//   Linux:    $XDG_DATA_HOME/smriti  (or ~/.local/share/smriti)
//
// We previously shipped under the "Recall" name. On first boot of the renamed
// build we look for the legacy directory and copy the database over so users
// keep their existing archive without lifting a finger.

const NEW_NAME = "Smriti";
const LEGACY_NAME = "Recall";

export function dataDir(): string {
  const p = platform();
  let dir: string;
  if (p === "win32") {
    dir = join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), NEW_NAME);
  } else if (p === "darwin") {
    dir = join(homedir(), "Library", "Application Support", NEW_NAME);
  } else {
    dir = join(
      process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
      NEW_NAME.toLowerCase(),
    );
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

function legacyDataDir(): string {
  const p = platform();
  if (p === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), LEGACY_NAME);
  } else if (p === "darwin") {
    return join(homedir(), "Library", "Application Support", LEGACY_NAME);
  } else {
    return join(
      process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
      LEGACY_NAME.toLowerCase(),
    );
  }
}

export function dbPath(): string {
  const newPath = join(dataDir(), "smriti.db");

  // One-time migration from the legacy Recall directory. We COPY rather than
  // move so the old file remains as a safety net until the user deletes it
  // manually. Same for the WAL/SHM sidecars if present.
  if (!existsSync(newPath)) {
    const oldDir = legacyDataDir();
    const oldPath = join(oldDir, "recall.db");
    if (existsSync(oldPath)) {
      try {
        copyFileSync(oldPath, newPath);
        // Sidecars — best-effort.
        for (const ext of ["-wal", "-shm"]) {
          const src = oldPath + ext;
          if (existsSync(src)) copyFileSync(src, newPath + ext);
        }
      } catch {
        // If copy fails, fall through — fresh DB will be created.
      }
    }
  }
  return newPath;
}

export function logPath(): string {
  return join(dataDir(), "helper.log");
}
