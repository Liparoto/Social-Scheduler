import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

/**
 * Fresh migrated SQLite file in a temp dir, wired up as DATABASE_PATH.
 *
 * MUST be called before importing lib/queries.ts: lib/config.ts reads DATABASE_PATH once
 * at module load, so an import that happens first would bind to the REAL database.
 * That is why every test here uses a dynamic `await import(...)` rather than a top-level one.
 */
export function makeTestDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ss-test-"));
  const dbPath = path.join(dir, "test.db");
  execFileSync("python3", ["migrate.py"], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_PATH: dbPath },
    stdio: "pipe",
  });
  process.env.DATABASE_PATH = dbPath;
  return dbPath;
}
