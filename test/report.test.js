import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { run } from "../src/index.js";
import { updateGitignore } from "../src/gitignore.js";
import { conflictRegions } from "../src/report.js";
import { capture, createGit, tempDir } from "./helpers.js";

const when = new Date(2026, 10, 22, 14, 0, 15);

function localDatePart(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getDate())}${pad(date.getMonth() + 1)}${pad(date.getFullYear() % 100)}`;
}

async function runCheck(args, git, extra = {}) {
  const cwd = extra.cwd ?? await tempDir();
  const io = capture();
  const code = await run(["node", "yf-merge-check", ...args], {
    cwd,
    exit: false,
    stdout: io.stdout,
    stderr: io.stderr,
    spawnGit: git.spawnGit,
    now: () => when,
  });
  return { code, out: io.out(), err: io.err(), cwd, calls: git.calls };
}

test("outside a repo, exit 2 and fetch is not called", async () => {
  const cwd = await tempDir();
  try {
    const git = createGit({ toplevel: cwd, verify: null });
    const { code, err, calls } = await runCheck(["--fetch", "--base", "main", "feature/a"], git, { cwd });
    assert.equal(code, 2);
    assert.equal(err, "Error: Not a git repository.\n");
    assert.deepEqual(calls.map((call) => call.args), [["rev-parse", "--show-toplevel"]]);
    assert.equal(calls[0].cwd, cwd);
    assert.deepEqual(await readdir(cwd), []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("git missing exits 2", async () => {
  const cwd = await tempDir();
  try {
    const io = capture();
    const code = await run(["node", "yf-merge-check", "--base", "main", "feature/a"], {
      cwd,
      exit: false,
      stdout: io.stdout,
      stderr: io.stderr,
      spawnGit: () => {
        const err = new Error("spawn git ENOENT");
        err.code = "ENOENT";
        throw err;
      },
    });
    assert.equal(code, 2);
    assert.equal(io.err(), "Error: git is not available.\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("fetch runs after the repo check and before rev-parse of the branch names", async () => {
  const cwd = await tempDir();
  try {
    const git = createGit({
      toplevel: cwd,
      verify: { "refs/heads/main": "abc1234", "refs/heads/feature/a": "def5678" },
      merges: [{ code: 0 }],
    });
    const { code } = await runCheck(["--fetch", "--fetch", "--base", "main", "feature/a"], git, { cwd });
    assert.equal(code, 0);
    const commands = git.calls.map((call) => call.args.join(" "));
    const fetchAt = commands.findIndex((command) => command === "fetch --all --prune");
    const verifyAt = commands.findIndex((command) => command.startsWith("rev-parse --verify"));
    assert.equal(commands.filter((command) => command === "fetch --all --prune").length, 1);
    assert.ok(fetchAt > 0);
    assert.equal(commands[0], "rev-parse --show-toplevel");
    assert.ok(verifyAt > fetchAt);
    assert.equal(git.calls[1].cwd, cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a failed fetch writes no report and does not resolve names", async () => {
  const cwd = await tempDir();
  try {
    const calls = [];
    const io = capture();
    const code = await run(["node", "yf-merge-check", "--fetch", "--base", "main", "feature/a"], {
      cwd,
      exit: false,
      stdout: io.stdout,
      stderr: io.stderr,
      spawnGit: async (args) => {
        calls.push(args.join(" "));
        if (args[0] === "rev-parse") return { code: 0, stdout: `${cwd}\n`, stderr: "" };
        if (args[0] === "fetch") return { code: 1, stdout: "", stderr: "fatal: no remote\n" };
        throw new Error(`unexpected ${args.join(" ")}`);
      },
    });
    assert.equal(code, 2);
    assert.equal(io.err(), "Error: git fetch failed.\nfatal: no remote\n");
    assert.deepEqual(calls, ["rev-parse --show-toplevel", "fetch --all --prune"]);
    assert.deepEqual(await readdir(cwd), []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("fetch uses stdout when stderr is empty", async () => {
  const cwd = await tempDir();
  try {
    const io = capture();
    const code = await run(["node", "yf-merge-check", "--fetch", "--base", "main", "feature/a"], {
      cwd,
      exit: false,
      stdout: io.stdout,
      stderr: io.stderr,
      spawnGit: async (args) => {
        if (args[0] === "rev-parse") return { code: 0, stdout: `${cwd}\n`, stderr: "" };
        return { code: 1, stdout: "from stdout\n", stderr: "  \n" };
      },
    });
    assert.equal(code, 2);
    assert.equal(io.err(), "Error: git fetch failed.\nfrom stdout\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a missing branch exits 2 and writes no report", async () => {
  const cwd = await tempDir();
  try {
    const git = createGit({
      toplevel: cwd,
      verify: { "refs/heads/main": "abc1234" },
    });
    const { code, err } = await runCheck(["--base", "main", "feature/missing"], git, { cwd });
    assert.equal(code, 2);
    assert.equal(err, "Error: Branch not found: feature/missing.\n");
    assert.equal(git.calls.some((call) => call.args[0] === "worktree"), false);
    assert.deepEqual(await readdir(cwd), []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a worktree that cannot be created exits 2 with no report", async () => {
  const cwd = await tempDir();
  try {
    const git = createGit({
      toplevel: cwd,
      verify: { "refs/heads/main": "abc1234", "refs/heads/feature/a": "def5678" },
      worktreeError: "fatal: invalid reference\n",
    });
    const { code, err } = await runCheck(["--base", "main", "feature/a"], git, { cwd });
    assert.equal(code, 2);
    assert.equal(err, "Error: fatal: invalid reference.\n");
    assert.deepEqual(await readdir(cwd), []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a clean merge prints PASS and a clean report with both stamps", async () => {
  const cwd = await tempDir();
  try {
    const git = createGit({
      toplevel: cwd,
      verify: { "refs/heads/main": "abc1234", "refs/heads/feature/a": "def5678" },
      merges: [{ code: 0, stdout: "Already up to date.\n" }],
    });
    const { code, out } = await runCheck(["--base", "main", "feature/a"], git, { cwd });
    assert.equal(code, 0);
    assert.equal(out, "PASS  0 conflicted lines\n");
    const report = await readFile(path.join(cwd, "yf-merge", `report_${localDatePart(when)}_1.md`), "utf8");
    assert.equal(report.endsWith("\n"), true);
    assert.match(report, /Result: clean\nConflicted lines: 0\n$/);
    assert.match(report, /Mode: each target against the base/);
    assert.match(report, /Base: main \(refs\/heads\/main @ abc1234\)/);
    assert.match(report, /- feature\/a \(refs\/heads\/feature\/a @ def5678\)/);
    const utc = report.match(/UTC: (\d{2}-[A-Z][a-z]{2}-\d{4}-\d{2}-\d{2}-\d{2})/);
    const local = report.match(/System OS: (\d{2}-[A-Z][a-z]{2}-\d{4}-\d{2}-\d{2}-\d{2})/);
    assert.ok(utc && local);
    assert.equal(parseStamp(utc[1], true).getTime(), when.getTime());
    assert.equal(parseStamp(local[1], false).getTime(), when.getTime());
    assert.equal(git.calls.some((call) => call.args.includes("commit")), false);
    assert.equal(git.calls.some((call) => call.args[0] === "fetch"), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("step 3 stores the name the user typed", async () => {
  const cwd = await tempDir();
  try {
    const git = createGit({
      toplevel: cwd,
      verify: { "refs/heads/main": "abc1234", "upstream/feature": "aaa1111" },
      merges: [{ code: 0 }],
    });
    await runCheck(["--base", "main", "upstream/feature"], git, { cwd });
    const report = await readFile(path.join(cwd, "yf-merge", `report_${localDatePart(when)}_1.md`), "utf8");
    assert.match(report, /- upstream\/feature \(upstream\/feature @ aaa1111\)/);
    const verifyArgs = git.calls
      .filter((call) => call.args[1] === "--verify")
      .map((call) => call.args.at(-1));
    assert.deepEqual(verifyArgs.filter((candidate) => candidate.includes("upstream/feature")), [
      "refs/heads/upstream/feature",
      "refs/remotes/origin/upstream/feature",
      "upstream/feature",
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("default mode drops a repeated target", async () => {
  const cwd = await tempDir();
  try {
    const git = createGit({
      toplevel: cwd,
      verify: { "refs/heads/main": "abc1234", "refs/heads/feature/a": "def5678" },
      merges: [{ code: 0 }],
    });
    await runCheck(["--base", "main", "feature/a", "feature/a"], git, { cwd });
    const merges = git.calls.filter((call) => call.args[2] === "merge");
    assert.equal(merges.length, 1);
    const report = await readFile(path.join(cwd, "yf-merge", `report_${localDatePart(when)}_1.md`), "utf8");
    assert.equal(report.match(/## feature\/a/g).length, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("two reports on the same local date increment, and a gap uses the highest suffix", async () => {
  const cwd = await tempDir();
  try {
    const verify = { "refs/heads/main": "abc1234", "refs/heads/feature/a": "def5678" };
    const first = createGit({ toplevel: cwd, verify, merges: [{ code: 0 }] });
    const second = createGit({ toplevel: cwd, verify, merges: [{ code: 0 }] });
    await runCheck(["--base", "main", "feature/a"], first, { cwd });
    await runCheck(["--base", "main", "feature/a"], second, { cwd });
    const datePart = localDatePart(when);
    const dir = path.join(cwd, "yf-merge");
    assert.equal(await stat(path.join(dir, `report_${datePart}_1.md`)).then((info) => info.isFile()), true);
    assert.equal(await stat(path.join(dir, `report_${datePart}_2.md`)).then((info) => info.isFile()), true);

    await writeFile(path.join(dir, `report_${datePart}_3.md`), "keep\n");
    await rm(path.join(dir, `report_${datePart}_2.md`));
    await writeFile(path.join(dir, "report.md"), "other\n");
    await mkdir(path.join(dir, `report_${datePart}_9.md`));
    const third = createGit({ toplevel: cwd, verify, merges: [{ code: 0 }] });
    await runCheck(["--base", "main", "feature/a"], third, { cwd });
    assert.equal(await stat(path.join(dir, `report_${datePart}_4.md`)).then((info) => info.isFile()), true);
    assert.equal(await readFile(path.join(dir, "report.md"), "utf8"), "other\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("conflict markers are counted and quoted, binary counts as one, other files do not", async () => {
  const cwd = await tempDir();
  try {
    const app = [
      ...Array.from({ length: 11 }, () => "context"),
      "<<<<<<< HEAD",
      "const port = 3000;",
      "=======",
      "const port = 8080;",
      ">>>>>>> feature/b",
      "between",
      "<<<<<<< HEAD",
      "export const name = \"staging\";",
      "```",
      "=======",
      "export const name = \"feature\";",
      ">>>>>>> feature/b",
      "",
    ].join("\n");
    const regions = conflictRegions(app);
    assert.equal(regions.length, 2);
    const git = createGit({
      toplevel: cwd,
      verify: {
        "refs/heads/staging": "a1b2c3d",
        "refs/heads/feature/a": "e4f5a6b",
        "refs/heads/feature/b": "1122334",
      },
      merges: [
        { code: 0 },
        {
          code: 1,
          stderr: "CONFLICT (content): Merge conflict in src/app.js\n",
          diff: "src/app.js\nassets/logo.png\n",
          files: {
            "src/app.js": app,
            "docs/notes.md": "<<<<<<< not unmerged\n",
          },
          buffers: { "assets/logo.png": Buffer.from([0xff, 0xfe, 0x00]) },
        },
      ],
    });
    const { code, out } = await runCheck(
      ["--base", "staging", "--branches", "feature/a", "feature/b"],
      git,
      { cwd },
    );
    assert.equal(code, 1);
    assert.equal(out, "FAIL  3 conflicted lines\n");
    const report = await readFile(path.join(cwd, "yf-merge", `report_${localDatePart(when)}_1.md`), "utf8");
    assert.match(report, /## feature\/a\n\nResult: clean\nConflicted lines: 0/);
    assert.match(report, /## feature\/b\n\nResult: conflict\nConflicted lines: 3/);
    assert.match(report, /- `src\/app\.js` — 2/);
    assert.match(report, /- `assets\/logo\.png` — binary\/tree conflict/);
    assert.equal(report.includes("docs/notes.md"), false);
    assert.equal(report.includes("### assets/logo.png"), false);
    assert.match(report, new RegExp(`#### Conflict 1, line ${regions[0].line}`));
    assert.match(report, new RegExp(`#### Conflict 2, line ${regions[1].line}`));
    assert.ok(report.includes(regions[0].text));
    const fence = "`".repeat(4);
    assert.ok(report.includes(`${fence}\n${regions[1].text}\n${fence}`));
    assert.equal(regions[0].line, 12);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("one conflicted line stays plural", async () => {
  const cwd = await tempDir();
  try {
    const git = createGit({
      toplevel: cwd,
      verify: { "refs/heads/main": "abc1234", "refs/heads/feature/a": "def5678" },
      merges: [{
        code: 1,
        stderr: "CONFLICT\n",
        diff: "only.js\n",
        files: { "only.js": "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feature/a\n" },
      }],
    });
    const { code, out } = await runCheck(["--base", "main", "feature/a"], git, { cwd });
    assert.equal(code, 1);
    assert.equal(out, "FAIL  1 conflicted lines\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a failed merge with no unmerged files quotes the git message", async () => {
  const cwd = await tempDir();
  try {
    const one = createGit({
      toplevel: cwd,
      verify: { "refs/heads/main": "abc1234", "refs/heads/feature/b": "1122334" },
      merges: [{ code: 1, stderr: "refusing to merge unrelated histories\n", diff: "" }],
    });
    await runCheck(["--base", "main", "feature/b"], one, { cwd });
    const first = await readFile(path.join(cwd, "yf-merge", `report_${localDatePart(when)}_1.md`), "utf8");
    assert.match(first, /Result: failed\nConflicted lines: 0\n\ngit: refusing to merge unrelated histories\n$/);
    assert.equal(first.includes("```"), false);

    const message = "fatal: refusing to merge unrelated histories\n```\nhint: not something we can merge";
    const two = createGit({
      toplevel: cwd,
      verify: { "refs/heads/main": "abc1234", "refs/heads/feature/b": "1122334" },
      merges: [{ code: 1, stderr: message, diff: "" }],
    });
    const { out } = await runCheck(["--base", "main", "feature/b"], two, { cwd });
    assert.equal(out, "FAIL  0 conflicted lines\n");
    const second = await readFile(path.join(cwd, "yf-merge", `report_${localDatePart(when)}_2.md`), "utf8");
    assert.ok(second.includes("git:\n\n````\nfatal: refusing to merge unrelated histories\n```\nhint: not something we can merge\n````\n"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("stack commits a clean first step, stops on the first conflict, and marks the rest not run", async () => {
  const cwd = await tempDir();
  try {
    const git = createGit({
      toplevel: cwd,
      verify: {
        "refs/heads/staging": "a1b2c3d",
        "refs/heads/feature/a": "e4f5a6b",
        "refs/heads/feature/b": "1122334",
        "refs/heads/feature/c": "abcd999",
      },
      merges: [
        { code: 0, stdout: "Merge made by the 'ort' strategy.\n" },
        {
          code: 1,
          stderr: "CONFLICT\n",
          diff: "src/app.js\n",
          files: { "src/app.js": "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feature/b\n" },
        },
      ],
    });
    const { code, out } = await runCheck(
      ["feature/a", "--base", "staging", "--branches", "feature/b", "feature/c", "--stack"],
      git,
      { cwd },
    );
    assert.equal(code, 1);
    assert.equal(out, "FAIL  1 conflicted lines\n");
    const merges = git.calls.filter((call) => call.args[2] === "merge");
    assert.equal(merges.length, 2);
    const commit = git.calls.find((call) => call.args.includes("commit"));
    assert.ok(commit);
    assert.deepEqual(commit.args.slice(2), [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--no-edit",
      "-m",
      "yf-merge-check: feature/a",
    ]);
    assert.equal(commit.env.GIT_AUTHOR_NAME, "yf-merge-check");
    assert.equal(commit.env.GIT_COMMITTER_NAME, "yf-merge-check");
    assert.equal(commit.env.GIT_AUTHOR_EMAIL, "yf-merge-check@localhost");
    assert.equal(commit.env.GIT_COMMITTER_EMAIL, "yf-merge-check@localhost");
    const report = await readFile(path.join(cwd, "yf-merge", `report_${localDatePart(when)}_1.md`), "utf8");
    assert.match(report, /Mode: stack/);
    assert.match(report, /## feature\/a\n\nResult: clean/);
    assert.match(report, /## feature\/b\n\nResult: conflict/);
    assert.match(report, /## feature\/c\n\nResult: not run\nThe chain stopped at feature\/b\./);
    assert.match(report, /- feature\/a \(refs\/heads\/feature\/a @ e4f5a6b\)\n- feature\/b \(refs\/heads\/feature\/b @ 1122334\)\n- feature\/c \(refs\/heads\/feature\/c @ abcd999\)/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("an already up to date stack step does not commit", async () => {
  const cwd = await tempDir();
  try {
    const git = createGit({
      toplevel: cwd,
      verify: { "refs/heads/main": "abc1234", "refs/heads/feature/a": "def5678" },
      merges: [{ code: 0, stdout: "Already up to date.\n" }],
    });
    const { code } = await runCheck(["--stack", "--base", "main", "feature/a"], git, { cwd });
    assert.equal(code, 0);
    assert.equal(git.calls.some((call) => call.args.includes("commit")), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("the report stays in the current directory and gitignore is updated at the repo root", async () => {
  const root = await tempDir();
  const cwd = path.join(root, "packages", "web");
  try {
    await mkdir(cwd, { recursive: true });
    await writeFile(path.join(root, ".gitignore"), "foo");
    const git = createGit({
      toplevel: root,
      verify: { "refs/heads/main": "abc1234", "refs/heads/feature/a": "def5678" },
      merges: [{ code: 0 }, { code: 0 }],
    });
    const first = await runCheck(["--gitignore", "--base", "main", "feature/a"], git, { cwd });
    assert.equal(first.out, "PASS  0 conflicted lines\nadded yf-merge/ to .gitignore\n");
    assert.equal(await readFile(path.join(root, ".gitignore"), "utf8"), "foo\nyf-merge/\n");
    const reportDir = path.join(cwd, "yf-merge");
    assert.equal((await readdir(reportDir)).length, 1);
    assert.equal(await readdir(root).then((names) => names.includes("yf-merge")), false);

    const second = createGit({
      toplevel: root,
      verify: { "refs/heads/main": "abc1234", "refs/heads/feature/a": "def5678" },
      merges: [{ code: 0 }],
    });
    const again = await runCheck(["--gitignore", "--base", "main", "feature/a"], second, { cwd });
    assert.equal(again.out, "PASS  0 conflicted lines\nyf-merge/ already in .gitignore\n");
    assert.equal(await readFile(path.join(root, ".gitignore"), "utf8"), "foo\nyf-merge/\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gitignore newline styles and existing patterns", async () => {
  const root = await tempDir();
  try {
    await writeFile(path.join(root, ".gitignore"), "foo\r\nbar");
    assert.equal(await updateGitignore(root), "added yf-merge/ to .gitignore");
    assert.equal(await readFile(path.join(root, ".gitignore"), "utf8"), "foo\r\nbar\r\nyf-merge/\r\n");

    const other = await tempDir();
    await writeFile(path.join(other, ".gitignore"), "keep\n/yf-merge\n");
    assert.equal(await updateGitignore(other), "yf-merge/ already in .gitignore");
    assert.equal(await readFile(path.join(other, ".gitignore"), "utf8"), "keep\n/yf-merge\n");
    await rm(other, { recursive: true, force: true });

    const empty = await tempDir();
    await writeFile(path.join(empty, ".gitignore"), "");
    assert.equal(await updateGitignore(empty), "added yf-merge/ to .gitignore");
    assert.equal(await readFile(path.join(empty, ".gitignore"), "utf8"), "yf-merge/\n");
    await rm(empty, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a gitignore write failure keeps the report, prints the result, and exits 2", async () => {
  const cwd = await tempDir();
  try {
    await mkdir(path.join(cwd, ".gitignore"));
    const git = createGit({
      toplevel: cwd,
      verify: { "refs/heads/main": "abc1234", "refs/heads/feature/a": "def5678" },
      merges: [{ code: 0 }],
    });
    const { code, out, err } = await runCheck(["--gitignore", "--base", "main", "feature/a"], git, { cwd });
    assert.equal(code, 2);
    assert.equal(out, "PASS  0 conflicted lines\n");
    assert.match(err, /Error: Cannot write .*[/\\]\.gitignore: .+\.\n/);
    assert.equal((await readdir(path.join(cwd, "yf-merge"))).length, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("an unclosed conflict region stops before the next marker", () => {
  const regions = conflictRegions("<<<<<<< A\nno end\n<<<<<<< B\n=======\n>>>>>>> C\n");
  assert.equal(regions.length, 2);
  assert.equal(regions[0].text, "<<<<<<< A\nno end");
  assert.equal(regions[1].line, 3);
  assert.equal(regions[1].text, "<<<<<<< B\n=======\n>>>>>>> C");
});

function parseStamp(stamp, utc) {
  const match = stamp.match(/^(\d{2})-([A-Za-z]{3})-(\d{4})-(\d{2})-(\d{2})-(\d{2})$/);
  assert.ok(match);
  const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const parts = [Number(match[3]), months[match[2]], Number(match[1]), Number(match[4]), Number(match[5]), Number(match[6])];
  return utc ? new Date(Date.UTC(...parts)) : new Date(...parts);
}
