import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatStamp(date, utc) {
  const day = utc ? date.getUTCDate() : date.getDate();
  const month = MONTHS[utc ? date.getUTCMonth() : date.getMonth()];
  const year = utc ? date.getUTCFullYear() : date.getFullYear();
  const hour = utc ? date.getUTCHours() : date.getHours();
  const minute = utc ? date.getUTCMinutes() : date.getMinutes();
  const second = utc ? date.getUTCSeconds() : date.getSeconds();
  return `${pad(day)}-${month}-${year}-${pad(hour)}-${pad(minute)}-${pad(second)}`;
}

export function fileDatePart(date) {
  return `${pad(date.getDate())}${pad(date.getMonth() + 1)}${pad(date.getFullYear() % 100)}`;
}

export function backtickFence(text) {
  let longest = 2;
  for (const run of text.matchAll(/`+/g)) {
    if (run[0].length > longest) longest = run[0].length;
  }
  return "`".repeat(longest + 1);
}

export function conflictRegions(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "" && /\r?\n$/.test(text)) {
    lines.pop();
  }
  const regions = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].startsWith("<<<<<<<")) continue;
    let end = i;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j].startsWith("<<<<<<<")) {
        end = j - 1;
        break;
      }
      end = j;
      if (lines[j].startsWith(">>>>>>>")) break;
    }
    regions.push({ line: i + 1, text: lines.slice(i, end + 1).join("\n") });
    i = end;
  }
  return regions;
}

export function renderReport({ when, mode, base, targets, results }) {
  const lines = [
    "# yf-merge-check",
    "",
    `UTC: ${formatStamp(when, true)}`,
    `System OS: ${formatStamp(when, false)}`,
    "",
    `Mode: ${mode}`,
    "",
    `Base: ${base.name} (${base.ref} @ ${base.sha})`,
    "",
    "Targets:",
    "",
  ];
  for (const target of targets) {
    lines.push(`- ${target.name} (${target.ref} @ ${target.sha})`);
  }
  lines.push("");
  for (const result of results) {
    lines.push(`## ${result.name}`, "");
    if (result.status === "clean") {
      lines.push("Result: clean", "Conflicted lines: 0", "");
    } else if (result.status === "not-run") {
      lines.push("Result: not run", `The chain stopped at ${result.stoppedAt}.`, "");
    } else if (result.status === "failed") {
      lines.push("Result: failed", "Conflicted lines: 0", "");
      lines.push(...gitLines(result.message), "");
    } else {
      lines.push("Result: conflict", `Conflicted lines: ${result.lines}`, "");
      for (const file of result.files) {
        if (file.binary) lines.push(`- \`${file.path}\` — binary/tree conflict`);
        else lines.push(`- \`${file.path}\` — ${file.regions.length}`);
      }
      lines.push("");
      for (const file of result.files) {
        if (file.binary) continue;
        lines.push(`### ${file.path}`, "");
        file.regions.forEach((region, index) => {
          const fence = backtickFence(region.text);
          lines.push(`#### Conflict ${index + 1}, line ${region.line}`, "", fence, region.text, fence, "");
        });
      }
    }
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

export async function writeReport(cwd, when, body) {
  const dir = path.join(cwd, "yf-merge");
  await mkdir(dir, { recursive: true });
  const datePart = fileDatePart(when);
  const pattern = new RegExp(`^report_${datePart}_(\\d+)\\.md$`);
  let highest = 0;
  for (const name of await readdir(dir)) {
    const match = pattern.exec(name);
    if (!match) continue;
    const info = await stat(path.join(dir, name));
    if (!info.isFile()) continue;
    const value = Number(match[1]);
    if (Number.isInteger(value) && value > highest) highest = value;
  }
  const filePath = path.join(dir, `report_${datePart}_${highest + 1}.md`);
  await writeFile(filePath, body, "utf8");
  return filePath;
}

function gitLines(message) {
  const trimmed = message.trim();
  if (!trimmed.includes("\n")) return [`git: ${trimmed}`];
  const fence = backtickFence(trimmed);
  return ["git:", "", fence, trimmed, fence];
}

function pad(value) {
  return String(value).padStart(2, "0");
}
