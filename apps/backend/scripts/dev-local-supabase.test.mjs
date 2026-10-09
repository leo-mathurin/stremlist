import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { migrateSmtpConfig, runSupabase } from "./dev-local-supabase.mjs";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

afterEach(() => vi.restoreAllMocks());

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
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: '{"SERVICE_ROLE_KEY":"private-key"}',
      stderr: `supabase start is already running.
Stopped services: [supabase_auth_test supabase_inbucket_test supabase_studio_test]
supabase local development setup is running.

A new version of Supabase CLI is available: v2.120.0 (currently installed v2.118.0)
We recommend updating regularly for new features and bug fixes: https://supabase.com/docs/guides/cli/getting-started#updating-the-supabase-cli
`,
    });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
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
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "{}",
      stderr: diagnostics,
    });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    runSupabase(["status"], { cwd: "/tmp", projectId: "test" });
    expect(stderr).toHaveBeenCalledWith(diagnostics);
  });

  it("preserves all stderr on failure without printing credential summaries", () => {
    const diagnostics =
      "Stopped services: [supabase_auth_test]\nError: database is unhealthy\n";
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: "private-key",
      stderr: diagnostics,
    });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(() =>
      runSupabase(["start"], { cwd: "/tmp", projectId: "test" }),
    ).toThrow("supabase start failed");
    expect(stderr).toHaveBeenCalledWith(diagnostics);
    expect(stdout).not.toHaveBeenCalled();
  });
});
