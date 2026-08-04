import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

/**
 * Fresh migrated SQLite file in a temp dir, wired up as DATABASE_PATH — and an isolated
 * ASSET_STORAGE_DIR alongside it.
 *
 * MUST be called before importing lib/queries.ts: lib/config.ts reads DATABASE_PATH once
 * at module load, so an import that happens first would bind to the REAL database.
 * That is why every test here uses a dynamic `await import(...)` rather than a top-level one.
 *
 * ASSET_STORAGE_DIR is isolated for the same reason, and it matters as soon as a test
 * writes a FILE rather than just a row: config.assetStorageDir otherwise resolves to the
 * repo's real data/assets, and fixture images end up in the owner's actual asset store —
 * mixed in with real uploads, where nothing distinguishes them from content they meant to
 * keep. Route tests that render derivatives (story canvases, conformed images) do exactly
 * that, so the isolation belongs here rather than in each test.
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
  process.env.ASSET_STORAGE_DIR = path.join(dir, "assets");
  return dbPath;
}
