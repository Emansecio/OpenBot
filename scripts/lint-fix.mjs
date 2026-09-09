import { spawnSync } from "node:child_process";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const inputs = process.argv.slice(2);
const sourceExtensions = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"]);

if (inputs.length === 0) {
  console.error("Usage: npm run lint:fix -- <file> [file ...]");
  process.exit(2);
}

for (const input of inputs) {
  if (input.startsWith("-")) {
    console.error(`lint:fix accepts file paths only: ${input}`);
    process.exit(2);
  }
  const absolute = resolve(root, input);
  const projectPath = relative(root, absolute);
  const topLevel = projectPath.split(sep)[0];
  const allowed = !isAbsolute(projectPath)
    && projectPath !== ""
    && !projectPath.startsWith(`..${sep}`)
    && sourceExtensions.has(extname(projectPath))
    && (topLevel === "src" || topLevel === "test" || topLevel === "scripts" || projectPath === "vitest.config.ts");
  if (!allowed) {
    console.error(`lint:fix path is outside the owned lint scope: ${input}`);
    process.exit(2);
  }
}

const oxlintBin = fileURLToPath(new URL("../node_modules/oxlint/bin/oxlint", import.meta.url));
const safeFixRules = [
  "--allow=all",
  "--deny=eslint/no-useless-escape",
  "--deny=import/no-duplicates",
  "--deny=unicorn/no-useless-fallback-in-spread",
  "--deny=unicorn/no-useless-spread",
];
const result = spawnSync(process.execPath, [oxlintBin, ...inputs, ...safeFixRules, "--fix", "--quiet"], {
  cwd: root,
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
