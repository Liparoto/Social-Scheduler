import "server-only";
import fs from "node:fs";
import path from "node:path";

/*
  The dashboard and the Python worker share ONE install config: the .env at the
  repo root (one level above /dashboard). Next only auto-loads .env from its own
  root, so we read the repo-root .env ourselves — keeping a single source of truth.
*/

const REPO_ROOT = path.resolve(process.cwd(), "..");

function loadRootEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const text = fs.readFileSync(path.join(REPO_ROOT, ".env"), "utf8");
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const idx = line.indexOf("=");
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      if (key) out[key] = val;
    }
  } catch {
    /* no .env yet — fall back to defaults */
  }
  return out;
}

const fileEnv = loadRootEnv();

function get(key: string, fallback = ""): string {
  return process.env[key] ?? fileEnv[key] ?? fallback;
}

function resolveRepoPath(p: string): string {
  return path.isAbsolute(p) ? p : path.join(REPO_ROOT, p);
}

export const config = {
  repoRoot: REPO_ROOT,
  databasePath: resolveRepoPath(get("DATABASE_PATH", "data/socialscheduler.db")),
  assetStorageDir: resolveRepoPath(get("ASSET_STORAGE_DIR", "data/assets")),
  publicAssetBaseUrl: get("PUBLIC_ASSET_BASE_URL", ""),
  defaultTimezone: get("DEFAULT_TIMEZONE", "UTC"),
};

// Mirrors worker/config.py's dry_run_active(): DRY_RUN is a live safety switch, so treat
// anything other than an explicit "0" or "false" as ON, including it being unset — same
// fail-safe direction the worker takes (default dry-run ON).
export function isDryRun(): boolean {
  const raw = get("DRY_RUN", "1").trim().toLowerCase();
  return raw !== "0" && raw !== "false";
}
