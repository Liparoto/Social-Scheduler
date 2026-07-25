// Minimal ESM loader used by dashboard smoke-test scripts so they can import
// dashboard/*.ts files the same way Next's bundler does: extensionless relative
// specifiers (e.g. "./db") AND the "@/..." path alias (tsconfig.json maps "@/*" to
// "./*", the dashboard root) that route handlers and lib modules use. Node's native
// loader requires an explicit extension for relative specifiers and knows nothing
// about the "@/" alias at all, so we resolve the real file here before handing back
// to Node.
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const CANDIDATE_EXTS = [".ts", ".tsx", ".mjs", ".js"];
const DASHBOARD_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function withResolvedExt(basePath) {
  for (const ext of CANDIDATE_EXTS) {
    if (existsSync(basePath + ext)) return basePath + ext;
  }
  return null;
}

// Next.js ships no "exports" map in its package.json, so Node's strict ESM resolver
// (unlike Next's own webpack/swc pipeline, which route handlers normally run under)
// won't infer the ".js" extension for a bare deep-import subpath like "next/server" —
// it 404s. Route-handler smoke scripts need to import real route modules (which import
// "next/server" for NextRequest/NextResponse), so resolve this one well-known subpath
// explicitly rather than teaching the loader Node's whole legacy resolution algorithm.
const NEXT_SERVER_FILE = path.join(DASHBOARD_ROOT, "node_modules", "next", "server.js");

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "next/server" && existsSync(NEXT_SERVER_FILE)) {
    return nextResolve(pathToFileURL(NEXT_SERVER_FILE).href, context);
  }
  if (specifier.startsWith("@/")) {
    const basePath = path.join(DASHBOARD_ROOT, specifier.slice(2));
    const resolved = withResolvedExt(basePath);
    if (resolved) {
      return nextResolve(pathToFileURL(resolved).href, context);
    }
  }
  if (specifier.startsWith(".") && !path.extname(specifier)) {
    const basePath = fileURLToPath(new URL(specifier, context.parentURL));
    const resolved = withResolvedExt(basePath);
    if (resolved) {
      return nextResolve(pathToFileURL(resolved).href, context);
    }
  }
  return nextResolve(specifier, context);
}
