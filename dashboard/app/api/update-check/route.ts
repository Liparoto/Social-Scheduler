import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

export const runtime = "nodejs";

// This endpoint only ever READS git state (fetch + rev comparisons). It never pulls,
// merges, or writes anything — applying an update is done from outside the running server,
// by double-clicking the Update-Mac / Update-Windows script (see readme + the launcher).

const run = promisify(execFile);

// The dev server's cwd is /dashboard; the repo (and its .git) is one level up.
const REPO_ROOT = path.resolve(process.cwd(), "..");

type UpdateState =
  | { state: "behind"; behind: number; currentSha: string; latestSha: string; platform: Platform }
  | { state: "current"; currentSha: string; platform: Platform }
  | { state: "unknown"; reason: string; platform: Platform };

type Platform = "mac" | "windows" | "other";

function platform(): Platform {
  if (process.platform === "darwin") return "mac";
  if (process.platform === "win32") return "windows";
  return "other";
}

// A read-only check hits the network (git fetch), so cache it briefly. Navigating between
// pages then reuses the last result instead of fetching every time. `?force=1` bypasses it.
let cache: { at: number; data: UpdateState } | null = null;
const TTL_MS = 5 * 60 * 1000;

async function git(args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd: REPO_ROOT, timeout: 15_000 });
  return stdout.trim();
}

async function check(): Promise<UpdateState> {
  const plat = platform();

  if (!existsSync(path.join(REPO_ROOT, ".git"))) {
    return { state: "unknown", reason: "This copy isn't a git checkout, so it can't check for updates.", platform: plat };
  }

  // Refresh remote tracking refs. If this fails, we're almost certainly offline / can't
  // reach the code host — report that honestly rather than comparing against stale data.
  try {
    await git(["fetch", "--quiet"]);
  } catch {
    return { state: "unknown", reason: "Couldn't reach the internet to check for updates.", platform: plat };
  }

  let currentSha: string;
  let latestSha: string;
  try {
    currentSha = await git(["rev-parse", "--short", "HEAD"]);
    latestSha = await git(["rev-parse", "--short", "@{u}"]);
  } catch {
    // No upstream tracking branch configured for this branch.
    return { state: "unknown", reason: "This copy has no upstream branch to compare against.", platform: plat };
  }

  let behind = 0;
  try {
    behind = Number(await git(["rev-list", "--count", "HEAD..@{u}"])) || 0;
  } catch {
    return { state: "unknown", reason: "Couldn't compare versions.", platform: plat };
  }

  if (behind > 0) {
    return { state: "behind", behind, currentSha, latestSha, platform: plat };
  }
  return { state: "current", currentSha, platform: plat };
}

export async function GET(req: Request) {
  const force = new URL(req.url).searchParams.get("force") === "1";

  if (!force && cache && Date.now() - cache.at < TTL_MS) {
    return NextResponse.json(cache.data);
  }

  const data = await check();
  cache = { at: Date.now(), data };
  return NextResponse.json(data);
}
