import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const PRESENT = new Set(["yf-merge/", "/yf-merge/", "yf-merge", "/yf-merge"]);

export async function updateGitignore(toplevel) {
  const file = path.join(toplevel, ".gitignore");
  try {
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      text = null;
    }
    if (text === null || text.length === 0) {
      await writeFile(file, "yf-merge/\n", "utf8");
      return "added yf-merge/ to .gitignore";
    }
    const lines = text.split(/\r?\n/);
    if (lines.some((line) => PRESENT.has(line.trim()))) {
      return "yf-merge/ already in .gitignore";
    }
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    let next = text;
    if (!text.endsWith("\n") && !text.endsWith("\r")) next += newline;
    next += `yf-merge/${newline}`;
    await writeFile(file, next, "utf8");
    return "added yf-merge/ to .gitignore";
  } catch (err) {
    err.gitignorePath = file;
    throw err;
  }
}
