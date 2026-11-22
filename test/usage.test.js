import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { run } from "../src/index.js";
import { capture } from "./helpers.js";

const HELP = `Check whether a merge would conflict. The current branch is not changed.

Usage:
  yf-merge-check --base <branch> <target>...
  yf-merge-check --base <branch> --branches <target>...
  yf-merge-check --stack --base <branch> <target>...

Options:
  --base <branch>       Branch the targets merge into. Required.
  --branches <name...>  Target branches. Names after the flags count too.
  --stack               Merge targets in order onto each other, starting from the base.
  --fetch               git fetch --all --prune before resolving names.
  --gitignore           Add yf-merge/ to the repository root .gitignore.
  -h, --help            Show this help.

There is no default base and no default target.
`;

async function quietRun(args) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "yf-merge-test-"));
  const io = capture();
  let calls = 0;
  try {
    const code = await run(["node", "yf-merge-check", ...args], {
      cwd,
      exit: false,
      stdout: io.stdout,
      stderr: io.stderr,
      spawnGit: () => {
        calls += 1;
        throw new Error("git should not be spawned");
      },
    });
    const entries = await readdir(cwd);
    return { code, out: io.out(), err: io.err(), calls, entries };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("help exits 0, prints the usage text, and writes no report", async () => {
  const result = await quietRun(["--help"]);
  assert.equal(result.code, 0);
  assert.equal(result.out, HELP);
  assert.equal(result.err, "");
  assert.equal(result.calls, 0);
  assert.deepEqual(result.entries, []);

  const also = await quietRun(["-h", "--base"]);
  assert.equal(also.code, 0);
  assert.equal(also.out, HELP);
  assert.equal(also.calls, 0);
});

test("usage errors exit 2 and do not spawn git", async () => {
  const cases = [
    [["feature/a"], "Error: --base <branch> is required.\n"],
    [["--base", "main"], "Error: at least one target branch is required.\n"],
    [["--base", "main", "--fetch=true", "feature/a"], "Error: Unknown option: --fetch=true.\n"],
    [["--base"], "Error: Missing value for --base.\n"],
    [["--base", "-main", "feature/a"], "Error: Missing value for --base.\n"],
    [["--base", "main", "--base", "other", "feature/a"], "Error: --base was given more than once.\n"],
    [["--base", "main", "--branches"], "Error: Missing value for --branches.\n"],
    [["--base", "main", "--branches", "--stack", "feature/a"], "Error: Missing value for --branches.\n"],
    [["--stack", "--base", "main", "feature/a", "feature/a"], "Error: duplicate target branch: feature/a\n"],
    [["--stack", "--base", "main", "--branches", "feature/a", "feature/a"], "Error: duplicate target branch: feature/a\n"],
  ];
  for (const [args, err] of cases) {
    const result = await quietRun(args);
    assert.equal(result.code, 2, args.join(" "));
    assert.equal(result.err, err, args.join(" "));
    assert.equal(result.out, "", args.join(" "));
    assert.equal(result.calls, 0, args.join(" "));
    assert.deepEqual(result.entries, [], args.join(" "));
  }
});
