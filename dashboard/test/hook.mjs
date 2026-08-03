import { registerHooks } from "node:module";
import { existsSync } from "node:fs";

const dashboardRoot = new URL("../", import.meta.url);

// Next's bundler resolves extensionless relative imports ("./db"); Node's ESM resolver
// does not, so importing lib/queries.ts directly fails on its own internal imports.
// Rewrite "./db" -> "./db.ts" only when the bare specifier isn't a real file, so a
// genuine extensionless file (or a package) still resolves normally.
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "next/server") return next("next/server.js", ctx);
    if (spec.startsWith("@/")) {
      const bare = new URL(spec.slice(2), dashboardRoot);
      const ts = new URL(spec.slice(2) + ".ts", dashboardRoot);
      if (!existsSync(bare) && existsSync(ts)) return next(ts.href, ctx);
      return next(bare.href, ctx);
    }
    if (spec.startsWith(".") && !/\.[a-z]+$/i.test(spec)) {
      const bare = new URL(spec, ctx.parentURL);
      const ts = new URL(spec + ".ts", ctx.parentURL);
      if (!existsSync(bare) && existsSync(ts)) return next(spec + ".ts", ctx);
    }
    return next(spec, ctx);
  },
});
