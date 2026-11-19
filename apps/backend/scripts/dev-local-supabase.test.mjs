import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { migrateSmtpConfig, runSupabase } from "./dev-local-supabase.mjs";

const cliDirs = [];

function installSupabaseCli({ status, stdout, stderr }) {
  const dir = mkdtempSync(join(tmpdir(), "stremlist-supabase-cli-"));
  cliDirs.push(dir);
  writeFileSync(join(dir, "stdout"), stdout);
  writeFileSync(join(dir, "stderr"), stderr);
  const cli = join(dir, "supabase");
  writeFileSync(
    cli,
    `#!/bin/sh\ncat "${dir}/stdout"\ncat "${dir}/stderr" >&2\nexit ${status}\n`,
  );
  chmodSync(cli, 0o755);
  vi.stubEnv("PATH", `${dir}${delimiter}${process.env.PATH ?? ""}`);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of cliDirs.splice(0)) rmSync(dir, { recursive: true });
});

describe("local Supabase startup", () => {
  it("uses the supported SMTP section in the source config", () => {
    const config = readFileSync(
      new URL("../../../supabase/config.toml", import.meta.url),
      "utf8",
    );
    expect(config).not.toMatch(/^\[inbucket\]/m);
    expect(config).toMatch(/^\[local_smtp\]/m);
  });

  it("migrates an existing worktree without changing its identity or ports", () => {
    const config = `project_id = "stremlist-dev-existing"
[api]
port = 56421
[inbucket]
enabled = true
port = 56424
`;
    const migrated = migrateSmtpConfig(config);
    expect(migrated).toBe(config.replace("[inbucket]", "[local_smtp]"));
    expect(migrateSmtpConfig(migrated)).toBe(migrated);
  });

  it("keeps credentials private and removes expected successful startup noise", () => {
    installSupabaseCli({
      status: 0,
      stdout: '{"SERVICE_ROLE_KEY":"private-key"}',
      stderr: `supabase start is already running.
Stopped services: [supabase_auth_test supabase_inbucket_test supabase_studio_test]
supabase local development setup is running.

A new version of Supabase CLI is available: v2.120.0 (currently installed v2.118.0)
We recommend updating regularly for new features and bug fixes: https://supabase.com/docs/guides/cli/getting-started#updating-the-supabase-cli
`,
    });
    const stderr = vi.spyOn(process.stderr, "write");
    const stdout = vi.spyOn(process.stdout, "write");
    expect(runSupabase(["status"], { cwd: "/tmp", projectId: "test" })).toBe(
      '{"SERVICE_ROLE_KEY":"private-key"}',
    );
    expect(stderr).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  });

  it("reports unexpected stopped services and other warnings", () => {
    const diagnostics = `Stopped services: [supabase_auth_test supabase_rest_test]
WARN: an unexpected configuration warning
`;
    installSupabaseCli({
      status: 0,
      stdout: "{}",
      stderr: diagnostics,
    });
    const stderr = vi.spyOn(process.stderr, "write");
    runSupabase(["status"], { cwd: "/tmp", projectId: "test" });
    expect(stderr).toHaveBeenCalledWith(diagnostics);
  });

  it("preserves all stderr on failure without printing credential summaries", () => {
    const diagnostics =
      "Stopped services: [supabase_auth_test]\nError: database is unhealthy\n";
    installSupabaseCli({
      status: 1,
      stdout: "private-key",
      stderr: diagnostics,
    });
    const stderr = vi.spyOn(process.stderr, "write");
    const stdout = vi.spyOn(process.stdout, "write");
    expect(() =>
      runSupabase(["start"], { cwd: "/tmp", projectId: "test" }),
    ).toThrow("supabase start failed");
    expect(stderr).toHaveBeenCalledWith(diagnostics);
    expect(stdout).not.toHaveBeenCalled();
  });
});
