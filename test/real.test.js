import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { run } from "../src/index.js";
import { capture, tempDir } from "./helpers.js";

const exec = promisify(execFile);

async function git(cwd, args) {
  const result = await exec("git", args, { cwd, windowsHide: true });
  return result.stdout;
}

async function initRepo() {
  const cwd = await tempDir();
  await git(cwd, ["init", "-b", "main"]);
  await git(cwd, ["config", "user.email", "test@example.com"]);
  await git(cwd, ["config", "user.name", "Test"]);
  await git(cwd, ["config", "commit.gpgsign", "false"]);
  await git(cwd, ["config", "core.autocrlf", "false"]);
  return cwd;
}

test("a real clean merge passes and leaves the branch alone", async () => {
  const cwd = await initRepo();
  try {
    await writeFile(path.join(cwd, "file.txt"), "base\n");
    await git(cwd, ["add", "file.txt"]);
    await git(cwd, ["commit", "-m", "base"]);
    await git(cwd, ["checkout", "-b", "feature/a"]);
    await writeFile(path.join(cwd, "added.txt"), "new\n");
    await git(cwd, ["add", "added.txt"]);
    await git(cwd, ["commit", "-m", "add"]);
    await git(cwd, ["checkout", "main"]);
    const before = await git(cwd, ["rev-parse", "HEAD"]);
    const io = capture();
    const code = await run(["node", "yf-merge-check", "--base", "main", "feature/a"], {
      cwd,
      exit: false,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    assert.equal(code, 0);
    assert.equal(io.out(), "PASS  0 conflicted lines\n");
    assert.equal(io.err(), "");
    assert.equal(await git(cwd, ["rev-parse", "HEAD"]), before);
    assert.equal((await git(cwd, ["status", "--porcelain"])).trim(), "?? yf-merge/");
    const names = await readdir(path.join(cwd, "yf-merge"));
    assert.equal(names.length, 1);
    const report = await readFile(path.join(cwd, "yf-merge", names[0]), "utf8");
    assert.match(report, /Result: clean/);
    assert.match(report, /UTC: \d{2}-[A-Z][a-z]{2}-\d{4}-\d{2}-\d{2}-\d{2}/);
    assert.match(report, /System OS: \d{2}-[A-Z][a-z]{2}-\d{4}-\d{2}-\d{2}-\d{2}/);
    const trees = await git(cwd, ["worktree", "list"]);
    assert.equal(trees.trim().split(/\r?\n/).length, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a real conflict is counted from the unmerged file", async () => {
  const cwd = await initRepo();
  try {
    await writeFile(path.join(cwd, "file.txt"), "base\n");
    await writeFile(path.join(cwd, "notes.md"), "<<<<<<< not a conflict\n");
    await git(cwd, ["add", "file.txt", "notes.md"]);
    await git(cwd, ["commit", "-m", "base"]);
    await git(cwd, ["checkout", "-b", "feature/b"]);
    await writeFile(path.join(cwd, "file.txt"), "feature\n");
    await git(cwd, ["commit", "-am", "feature"]);
    await git(cwd, ["checkout", "main"]);
    await writeFile(path.join(cwd, "file.txt"), "main\n");
    await git(cwd, ["commit", "-am", "main"]);
    const before = await git(cwd, ["rev-parse", "HEAD"]);
    const io = capture();
    const code = await run(["node", "yf-merge-check", "--base", "main", "feature/b"], {
      cwd,
      exit: false,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    assert.equal(code, 1);
    assert.equal(io.out(), "FAIL  1 conflicted lines\n");
    assert.equal(await git(cwd, ["rev-parse", "HEAD"]), before);
    assert.equal((await git(cwd, ["status", "--porcelain"])).trim(), "?? yf-merge/");
    const names = await readdir(path.join(cwd, "yf-merge"));
    const report = await readFile(path.join(cwd, "yf-merge", names[0]), "utf8");
    assert.match(report, /Result: conflict/);
    assert.match(report, /Conflicted lines: 1/);
    assert.match(report, /- `file\.txt` — 1/);
    assert.match(report, /<<<<<<< HEAD/);
    assert.equal(report.includes("notes.md"), false);
    const trees = await git(cwd, ["worktree", "list"]);
    assert.equal(trees.trim().split(/\r?\n/).length, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a real stack commits the clean step and does not run later targets", async () => {
  const cwd = await initRepo();
  try {
    await writeFile(path.join(cwd, "file.txt"), "base\n");
    await git(cwd, ["add", "file.txt"]);
    await git(cwd, ["commit", "-m", "base"]);
    await git(cwd, ["branch", "feature/a"]);
    await git(cwd, ["branch", "feature/c"]);
    await git(cwd, ["checkout", "feature/a"]);
    await writeFile(path.join(cwd, "file.txt"), "from-a\n");
    await git(cwd, ["commit", "-am", "a"]);
    await git(cwd, ["checkout", "-b", "feature/b", "main"]);
    await writeFile(path.join(cwd, "file.txt"), "from-b\n");
    await git(cwd, ["commit", "-am", "b"]);
    await git(cwd, ["checkout", "feature/c"]);
    await writeFile(path.join(cwd, "other.txt"), "later\n");
    await git(cwd, ["add", "other.txt"]);
    await git(cwd, ["commit", "-m", "c"]);
    await git(cwd, ["checkout", "main"]);
    const before = await git(cwd, ["rev-parse", "HEAD"]);
    const io = capture();
    const code = await run(
      ["node", "yf-merge-check", "--stack", "--base", "main", "feature/a", "feature/b", "feature/c"],
      { cwd, exit: false, stdout: io.stdout, stderr: io.stderr },
    );
    assert.equal(code, 1, io.err());
    assert.match(io.out(), /^FAIL  [1-9]\d* conflicted lines\n$/);
    const names = await readdir(path.join(cwd, "yf-merge"));
    const report = await readFile(path.join(cwd, "yf-merge", names[0]), "utf8");
    assert.match(report, /Mode: stack/);
    assert.match(report, /## feature\/a\n\nResult: clean/);
    assert.match(report, /## feature\/b\n\nResult: conflict/);
    assert.match(report, /## feature\/c\n\nResult: not run\nThe chain stopped at feature\/b\./);
    assert.equal(await git(cwd, ["rev-parse", "HEAD"]), before);
    const trees = await git(cwd, ["worktree", "list"]);
    assert.equal(trees.trim().split(/\r?\n/).length, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
