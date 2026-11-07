import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertJobDatabaseIdentity } from "../db/job-identity.js";
import { createPostgresRuntime } from "../db/postgres.js";

const mocks = vi.hoisted(() => ({ access: vi.fn(), media: vi.fn() }));
vi.mock("../access/migrations.js", () => ({ runAccessMigrations: mocks.access }));
vi.mock("../media-sync/migrations.js", () => ({ runMediaSyncMigrations: mocks.media }));
const accepted = {
  current_role: "hhc_line_jobs",
  session_role: "hhc_line_jobs",
  rolconnlimit: 6,
  rolcanlogin: true,
  rolsuper: false,
  rolcreaterole: false,
  rolcreatedb: false,
  rolreplication: false,
  rolbypassrls: false
};
afterEach(() => vi.clearAllMocks());
describe("job database admission", () => {
  it("accepts only the bounded nonprivileged effective login", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [accepted] });
    await expect(assertJobDatabaseIdentity({ query })).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledWith({
      text: expect.stringContaining("FROM pg_catalog.pg_roles WHERE rolname = current_user"),
      query_timeout: 2_000
    });
    for (const changed of [
      { current_role: "api_role" },
      { session_role: "admin" },
      { rolconnlimit: -1 },
      { rolconnlimit: 0 },
      { rolconnlimit: 7 },
      { rolcanlogin: false },
      ...["rolsuper", "rolcreaterole", "rolcreatedb", "rolreplication", "rolbypassrls"].map(
        (flag) => ({ [flag]: true })
      )
    ]) {
      query.mockResolvedValue({ rows: [{ ...accepted, ...changed }] });
      await expect(assertJobDatabaseIdentity({ query })).rejects.toThrow(
        "job_database_identity_rejected"
      );
    }
  });
  it("rejects before any migration or business initialization and closes the owned pool", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ...accepted, rolconnlimit: -1 }] });
    const close = vi.fn().mockResolvedValue(undefined);
    const owned = { pool: { query } as unknown as Pool, close };
    await expect(
      createPostgresRuntime({ url: "fixture", ssl: false }, owned, true)
    ).rejects.toThrow("job_database_identity_rejected");
    expect(mocks.access).not.toHaveBeenCalled();
    expect(mocks.media).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
  it("fails closed on missing DB and query failures without leaking errors", async () => {
    await expect(createPostgresRuntime(undefined, undefined, true)).rejects.toThrow(
      "job_database_required"
    );
    await expect(
      assertJobDatabaseIdentity({ query: vi.fn().mockRejectedValue(new Error("secret DSN")) })
    ).rejects.toThrow("job_database_identity_unverified");
  });
});
