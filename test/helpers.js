import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

export async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), "yf-merge-test-"));
}

export function capture() {
  const stdout = [];
  const stderr = [];
  return {
    stdout: { write: (chunk) => stdout.push(String(chunk)) },
    stderr: { write: (chunk) => stderr.push(String(chunk)) },
    out: () => stdout.join(""),
    err: () => stderr.join(""),
  };
}

export function ok(stdout = "", stderr = "") {
  return { code: 0, stdout, stderr };
}

export function fail(stderr = "", stdout = "", code = 1) {
  return { code, stdout, stderr };
}

export function createGit({ toplevel, verify, merges = [], worktreeError = null }) {
  const calls = [];
  let mergeIndex = 0;
  const byDir = new Map();

  async function spawnGit(args, opts = {}) {
    calls.push({ args: [...args], cwd: opts.cwd, env: opts.env });
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      if (verify === null) return fail("fatal: not a git repository", "", 128);
      return ok(`${toplevel}\n`);
    }
    if (args[0] === "fetch") return ok("");
    if (args[0] === "rev-parse" && args[1] === "--verify") {
      const candidate = args[args.length - 1];
      if (!Object.hasOwn(verify, candidate)) return fail("", "", 1);
      return ok(`${verify[candidate]}\n`);
    }
    if (args[0] === "rev-parse" && args[1] === "--short=7") {
      const candidate = args[args.length - 1];
      if (!Object.hasOwn(verify, candidate)) return fail("missing", "", 128);
      return ok(`${verify[candidate]}\n`);
    }
    if (args[0] === "worktree" && args[1] === "add") {
      if (worktreeError) return fail(worktreeError);
      return ok("");
    }
    if (args[0] === "worktree" && args[1] === "remove") return ok("");
    if (args[0] === "-C" && args[2] === "merge") {
      const dir = args[1];
      const scenario = merges[mergeIndex] ?? { code: 0, stdout: "", stderr: "", files: {}, diff: "" };
      mergeIndex += 1;
      byDir.set(dir, scenario);
      await writeScenario(dir, scenario);
      return { code: scenario.code ?? 0, stdout: scenario.stdout ?? "", stderr: scenario.stderr ?? "" };
    }
    if (args[0] === "-C" && args[2] === "diff") {
      const scenario = byDir.get(args[1]) ?? { diff: "" };
      return ok(scenario.diff ?? "");
    }
    if (args[0] === "-C" && args.includes("commit")) return ok("");
    throw new Error(`unexpected git: ${args.join(" ")}`);
  }

  return { spawnGit, calls };
}

async function writeScenario(dir, scenario) {
  for (const [name, text] of Object.entries(scenario.files ?? {})) {
    const full = path.join(dir, name);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, text);
  }
  for (const [name, bytes] of Object.entries(scenario.buffers ?? {})) {
    const full = path.join(dir, name);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, bytes);
  }
}
