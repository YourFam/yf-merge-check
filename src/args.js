import { createRequire } from "node:module";
import { CliError } from "./errors.js";

const require = createRequire(import.meta.url);
export const packageVersion = require("../package.json").version;

export const helpText = `Check whether a merge would conflict. The current branch is not changed.

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
  --version             Print the version and exit.
  -h, --help            Show this help.

There is no default base and no default target.
`;

export function parseArgs(argv) {
  const tokens = argv.slice(2);
  if (tokens.includes("--help") || tokens.includes("-h")) {
    return { help: true };
  }
  if (tokens.includes("--version")) {
    return { version: true };
  }

  let base;
  let baseSet = false;
  let stack = false;
  let fetch = false;
  let gitignore = false;
  const targets = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--stack") {
      stack = true;
      continue;
    }
    if (token === "--fetch") {
      fetch = true;
      continue;
    }
    if (token === "--gitignore") {
      gitignore = true;
      continue;
    }
    if (token === "--base" || token.startsWith("--base=")) {
      if (baseSet) {
        throw new CliError("Error: --base was given more than once.", 2);
      }
      const value = token === "--base" ? tokens[i + 1] : token.slice("--base=".length);
      if (token === "--base") i += 1;
      if (value === undefined || value === "" || value.startsWith("-")) {
        throw new CliError("Error: Missing value for --base.", 2);
      }
      base = value;
      baseSet = true;
      continue;
    }
    if (token === "--branches" || token.startsWith("--branches=")) {
      if (token.startsWith("--branches=")) {
        const value = token.slice("--branches=".length);
        if (value === "" || value.startsWith("-")) {
          throw new CliError("Error: Missing value for --branches.", 2);
        }
        targets.push(value);
        continue;
      }
      const next = tokens[i + 1];
      if (next === undefined || next.startsWith("-")) {
        throw new CliError("Error: Missing value for --branches.", 2);
      }
      while (i + 1 < tokens.length && !tokens[i + 1].startsWith("--")) {
        i += 1;
        if (tokens[i].startsWith("-")) {
          throw new CliError("Error: Missing value for --branches.", 2);
        }
        targets.push(tokens[i]);
      }
      continue;
    }
    if (token.startsWith("--")) {
      throw new CliError(`Error: Unknown option: ${token}.`, 2);
    }
    targets.push(token);
  }

  if (!baseSet) {
    throw new CliError("Error: --base <branch> is required.", 2);
  }
  if (targets.length === 0) {
    throw new CliError("Error: at least one target branch is required.", 2);
  }
  if (stack) {
    const seen = new Set();
    for (const target of targets) {
      if (seen.has(target)) {
        throw new CliError(`Error: duplicate target branch: ${target}`, 2);
      }
      seen.add(target);
    }
  }

  return {
    help: false,
    base,
    targets: stack ? targets : dedupe(targets),
    stack,
    fetch,
    gitignore,
  };
}

function dedupe(targets) {
  const seen = new Set();
  const kept = [];
  for (const target of targets) {
    if (seen.has(target)) continue;
    seen.add(target);
    kept.push(target);
  }
  return kept;
}
