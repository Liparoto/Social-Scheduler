import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const dashboardRoot = new URL("../", import.meta.url);
const clientReactModules = new Map([
  ["react", new URL("../node_modules/react/index.js", import.meta.url)],
  ["react/jsx-runtime", new URL("../node_modules/react/jsx-runtime.js", import.meta.url)],
  ["react/jsx-dev-runtime", new URL("../node_modules/react/jsx-dev-runtime.js", import.meta.url)],
  ["react-dom/server", new URL("../node_modules/react-dom/server.node.js", import.meta.url)],
]);

registerHooks({
  resolve(spec, ctx, next) {
    const clientReactModule = clientReactModules.get(spec);
    if (clientReactModule) return next(clientReactModule.href, ctx);
    if (spec === "next/link") {
      return next(new URL("./react-link-stub.mjs", import.meta.url).href, ctx);
    }
    // Same reason as next/link: a static render never navigates, and without this any
    // component calling useRouter() can't be UI-tested at all.
    if (spec === "next/navigation") {
      return next(new URL("./next-navigation-stub.mjs", import.meta.url).href, ctx);
    }
    if (spec.startsWith("@/")) {
      const bare = new URL(spec.slice(2), dashboardRoot);
      const ts = new URL(spec.slice(2) + ".ts", dashboardRoot);
      const tsx = new URL(spec.slice(2) + ".tsx", dashboardRoot);
      if (!existsSync(bare) && existsSync(ts)) return next(ts.href, ctx);
      if (!existsSync(bare) && existsSync(tsx)) return next(tsx.href, ctx);
      return next(bare.href, ctx);
    }
    // Extensionless relative import. Tries .tsx as well as .ts — a component importing a
    // sibling COMPONENT (./download-media-button) is at least as common as importing a
    // sibling hook (./use-modal-focus-trap), and while .ts-only resolution worked it made
    // the parent untestable with an error that names the import rather than the cause.
    // Mirrors the "@/" branch above, which has always handled both.
    if (spec.startsWith(".") && !/\.[a-z]+$/i.test(spec)) {
      const bare = new URL(spec, ctx.parentURL);
      if (!existsSync(bare)) {
        for (const ext of [".ts", ".tsx"]) {
          if (existsSync(new URL(spec + ext, ctx.parentURL))) return next(spec + ext, ctx);
        }
      }
    }
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url.endsWith(".tsx")) {
      const source = readFileSync(fileURLToPath(url), "utf8");
      return {
        format: "module",
        shortCircuit: true,
        source: ts.transpileModule(source, {
          compilerOptions: {
            jsx: ts.JsxEmit.ReactJSX,
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2022,
          },
          fileName: fileURLToPath(url),
        }).outputText,
      };
    }
    return next(url, ctx);
  },
});
