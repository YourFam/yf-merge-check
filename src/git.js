import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CliError } from "./errors.js";
import { conflictRegions } from "./report.js";

const AUTHOR_ENV = {
  GIT_AUTHOR_NAME: "yf-merge-check",
  GIT_COMMITTER_NAME: "yf-merge-check",
  GIT_AUTHOR_EMAIL: "yf-merge-check@localhost",
  GIT_COMMITTER_EMAIL: "yf-merge-check@localhost",
};

export function spawnGit(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: options.cwd,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_MERGE_AUTOEDIT: "no",
        GIT_EDITOR: "true",
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

export async function runGit(spawnImpl, args, options = {}) {
  let result;
  try {
    result = await spawnImpl(args, options);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw new CliError("Error: git is not available.", 2);
    }
    throw err;
  }
  return result;
}

export async function repoTop(spawnImpl, cwd) {
  const result = await runGit(spawnImpl, ["rev-parse", "--show-toplevel"], { cwd });
  if (result.code !== 0) {
    throw new CliError("Error: Not a git repository.", 2);
  }
  return result.stdout.trim();
}

export async function fetchAll(spawnImpl, toplevel) {
  const result = await runGit(spawnImpl, ["fetch", "--all", "--prune"], { cwd: toplevel });
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    const error = new CliError("Error: git fetch failed.", 2);
    error.detail = detail;
    throw error;
  }
}

export async function resolveName(spawnImpl, name, toplevel) {
  const candidates = [`refs/heads/${name}`, `refs/remotes/origin/${name}`, name];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const verified = await runGit(spawnImpl, ["rev-parse", "--verify", "--quiet", candidate], { cwd: toplevel });
    if (verified.code !== 0) continue;
    const short = await runGit(spawnImpl, ["rev-parse", "--short=7", candidate], { cwd: toplevel });
    if (short.code !== 0 || !short.stdout.trim()) continue;
    return {
      name,
      ref: index === 2 ? name : candidate,
      sha: short.stdout.trim(),
    };
  }
  throw new CliError(`Error: Branch not found: ${name}.`, 2);
}

export async function mergeTargets({ spawnImpl, toplevel, base, targets, stack }) {
  if (!stack) {
    const results = [];
    for (const target of targets) {
      results.push(await mergeOne(spawnImpl, toplevel, base.ref, target));
    }
    return results;
  }
  return mergeStack(spawnImpl, toplevel, base.ref, targets);
}

async function mergeOne(spawnImpl, toplevel, baseRef, target) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "yf-merge-check-"));
  try {
    await addWorktree(spawnImpl, toplevel, dir, baseRef);
    const merged = await runGit(
      spawnImpl,
      ["-C", dir, "merge", "--no-commit", "--no-ff", target.ref],
      { cwd: toplevel },
    );
    return { name: target.name, ...(await describeMerge(spawnImpl, toplevel, dir, merged)) };
  } finally {
    await removeWorktree(spawnImpl, toplevel, dir);
  }
}

async function mergeStack(spawnImpl, toplevel, baseRef, targets) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "yf-merge-check-"));
  const results = [];
  let stoppedAt = null;
  try {
    await addWorktree(spawnImpl, toplevel, dir, baseRef);
    for (const target of targets) {
      if (stoppedAt) {
        results.push({ name: target.name, status: "not-run", lines: 0, stoppedAt });
        continue;
      }
      const merged = await runGit(
        spawnImpl,
        ["-C", dir, "merge", "--no-commit", "--no-ff", target.ref],
        { cwd: toplevel },
      );
      const described = await describeMerge(spawnImpl, toplevel, dir, merged);
      results.push({ name: target.name, ...described });
      if (described.status !== "clean") {
        stoppedAt = target.name;
        continue;
      }
      if (!isAlreadyUpToDate(merged)) {
        const committed = await runGit(
          spawnImpl,
          ["-C", dir, "-c", "commit.gpgsign=false", "commit", "--no-edit", "-m", `yf-merge-check: ${target.name}`],
          { cwd: toplevel, env: AUTHOR_ENV },
        );
        if (committed.code !== 0) {
          const message = (committed.stderr.trim() || committed.stdout.trim());
          results[results.length - 1] = {
            name: target.name,
            status: "failed",
            lines: 0,
            message,
          };
          stoppedAt = target.name;
        }
      }
    }
  } finally {
    await removeWorktree(spawnImpl, toplevel, dir);
  }
  return results;
}

async function addWorktree(spawnImpl, toplevel, dir, baseRef) {
  const added = await runGit(spawnImpl, ["worktree", "add", "--detach", dir, baseRef], { cwd: toplevel });
  if (added.code !== 0) {
    const text = added.stderr.trim() || added.stdout.trim() || "git worktree add failed";
    const sentence = text.endsWith(".") ? text : `${text}.`;
    throw new CliError(`Error: ${sentence}`, 2);
  }
}

async function removeWorktree(spawnImpl, toplevel, dir) {
  try {
    await runGit(spawnImpl, ["worktree", "remove", "--force", dir], { cwd: toplevel });
  } catch {
    // The directory removal below still runs.
  }
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

async function describeMerge(spawnImpl, toplevel, dir, merged) {
  if (merged.code === 0) {
    return { status: "clean", lines: 0, files: [] };
  }
  const listed = await runGit(
    spawnImpl,
    ["-C", dir, "diff", "--name-only", "--diff-filter=U"],
    { cwd: toplevel },
  );
  const names = listed.stdout.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
  if (names.length === 0) {
    return {
      status: "failed",
      lines: 0,
      files: [],
      message: merged.stderr.trim() || merged.stdout.trim(),
    };
  }
  const files = [];
  for (const name of names) {
    files.push({ path: name, ...(await readConflict(path.join(dir, name))) });
  }
  const lines = files.reduce((sum, file) => sum + (file.binary ? 1 : file.regions.length), 0);
  return { status: "conflict", lines, files };
}

async function readConflict(filePath) {
  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch {
    return { binary: true, regions: [] };
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { binary: true, regions: [] };
  }
  const regions = conflictRegions(text);
  if (regions.length === 0) return { binary: true, regions: [] };
  return { binary: false, regions };
}

function isAlreadyUpToDate(result) {
  return `${result.stdout}\n${result.stderr}`.includes("Already up to date");
}
