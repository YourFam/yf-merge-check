#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = path.dirname(require.resolve("@yourfam/yf-merge-check/package.json"));
const bin = path.join(root, "bin", "yf-merge-check.js");
const child = spawn(process.execPath, [bin, ...process.argv.slice(2)], {
  stdio: "inherit",
  windowsHide: true,
});
child.on("exit", (code) => {
  process.exit(code ?? 1);
});
