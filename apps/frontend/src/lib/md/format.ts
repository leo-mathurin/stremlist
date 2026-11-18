import { absoluteUrl } from "../../content/site";

export function text(value: string) {
  return value.replace(/[\\`*_[\]<>|]/g, "\\$&");
}

export function heading(level: 1 | 2 | 3, value: string) {
  return `${"#".repeat(level)} ${text(value)}`;
}

export function link(label: string, path: string) {
  const url = absoluteUrl(path).replace(/\(/g, "%28").replace(/\)/g, "%29");
  return `[${text(label)}](${url})`;
}

export function list(items: readonly string[]) {
  return items.map((item) => `- ${item}`).join("\n");
}

export function table(headers: readonly string[], rows: string[][]) {
  const row = (cells: readonly string[]) =>
    `| ${cells.map(text).join(" | ")} |`;
  return [row(headers), row(headers.map(() => "---")), ...rows.map(row)].join(
    "\n",
  );
}

/** "November 9, 2026" as "2026-11-09", whatever the local time zone. */
export function date(value: string) {
  return new Date(`${value} UTC`).toISOString().slice(0, 10);
}
