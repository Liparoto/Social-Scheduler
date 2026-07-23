// Minimal ESM loader used ONLY by scripts/smoke-content-model.mjs so it can import
// dashboard/lib/*.ts files the same way Next's bundler does: extensionless relative
// specifiers (e.g. "./db"). Node's native loader requires an explicit extension for
// relative specifiers, so we resolve the real file here before handing back to Node.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const CANDIDATE_EXTS = [".ts", ".tsx", ".mjs", ".js"];

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && !path.extname(specifier)) {
    const basePath = fileURLToPath(new URL(specifier, context.parentURL));
    for (const ext of CANDIDATE_EXTS) {
      if (existsSync(basePath + ext)) {
        return nextResolve(specifier + ext, context);
      }
    }
  }
  return nextResolve(specifier, context);
}
