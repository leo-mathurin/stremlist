import { absoluteUrl } from "../../content/site";

export function text(value: string): string {
  return value.replace(/[\\`*_[\]<>|]/g, "\\$&");
}

export function heading(level: 1 | 2 | 3, value: string): string {
  return `${"#".repeat(level)} ${text(value)}`;
}

export function link(label: string, path: string): string {
  const url = absoluteUrl(path).replace(/\(/g, "%28").replace(/\)/g, "%29");
  return `[${text(label)}](${url})`;
}

export function list(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

export function table(headers: readonly string[], rows: string[][]): string {
  const row = (cells: readonly string[]) =>
    `| ${cells.map(text).join(" | ")} |`;
  return [row(headers), row(headers.map(() => "---")), ...rows.map(row)].join(
    "\n",
  );
}

export function date(value: string): string {
  return new Date(value).toISOString().slice(0, 10);
}
