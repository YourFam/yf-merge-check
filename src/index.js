import { parseArgs, helpText } from "./args.js";
import { CliError } from "./errors.js";
import { fetchAll, mergeTargets, repoTop, resolveName, spawnGit } from "./git.js";
import { updateGitignore } from "./gitignore.js";
import { renderReport, writeReport } from "./report.js";

export async function run(argv, options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const cwd = options.cwd ?? process.cwd();
  const spawnImpl = options.spawnGit ?? spawnGit;
  const now = options.now ?? (() => new Date());
  const shouldExit = options.exit !== false;
  let code = 2;
  try {
    code = await execute({ argv, stdout, stderr, cwd, spawnImpl, now });
  } catch (err) {
    if (err instanceof CliError && err.detail !== undefined) {
      stderr.write("Error: git fetch failed.\n");
      if (err.detail) stderr.write(`${err.detail}\n`);
      code = 2;
    } else {
      const line = err instanceof CliError ? err.message : `Error: ${err.message}`;
      stderr.write(line.endsWith("\n") ? line : `${line}\n`);
      code = err instanceof CliError ? err.exitCode : 2;
    }
  }
  if (shouldExit) process.exit(code);
  return code;
}

async function execute({ argv, stdout, stderr, cwd, spawnImpl, now }) {
  const args = parseArgs(argv);
  if (args.help) {
    stdout.write(helpText);
    return 0;
  }

  const toplevel = await repoTop(spawnImpl, cwd);
  if (args.fetch) await fetchAll(spawnImpl, toplevel);

  const base = await resolveName(spawnImpl, args.base, toplevel);
  const targets = [];
  for (const name of args.targets) {
    targets.push(await resolveName(spawnImpl, name, toplevel));
  }

  const results = await mergeTargets({
    spawnImpl,
    toplevel,
    base,
    targets,
    stack: args.stack,
  });
  const when = now();
  const mode = args.stack ? "stack" : "each target against the base";
  await writeReport(cwd, when, renderReport({ when, mode, base, targets, results }));

  const conflicted = results.reduce((sum, result) => {
    if (result.status === "not-run") return sum;
    return sum + result.lines;
  }, 0);
  const pass = results.every((result) => result.status === "clean");
  stdout.write(`${pass ? "PASS" : "FAIL"}  ${conflicted} conflicted lines\n`);

  if (args.gitignore) {
    try {
      const note = await updateGitignore(toplevel);
      stdout.write(`${note}\n`);
    } catch (err) {
      const file = err.gitignorePath ?? `${toplevel}/.gitignore`;
      stderr.write(`Error: Cannot write ${file}: ${err.message}.\n`);
      return 2;
    }
  }
  return pass ? 0 : 1;
}
