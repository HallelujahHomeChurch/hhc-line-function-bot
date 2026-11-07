import type pg from "pg";

const identityQuery = `SELECT current_user::text AS current_role,
 session_user::text AS session_role, rolconnlimit,
 rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
 FROM pg_catalog.pg_roles WHERE rolname = current_user`;

/** Fixed job-only admission; never use the API login for queue or catalog work. */
export async function assertJobDatabaseIdentity(pool: Pick<pg.Pool, "query">): Promise<void> {
  let rows: Record<string, unknown>[];
  try {
    const query: pg.QueryConfig & { query_timeout: number } = {
      text: identityQuery,
      query_timeout: 2_000
    };
    const result = await pool.query(query);
    rows = result.rows;
  } catch {
    throw new Error("job_database_identity_unverified");
  }
  const role = rows[0];
  if (
    rows.length !== 1 ||
    !role ||
    role.current_role !== "hhc_line_jobs" ||
    role.session_role !== "hhc_line_jobs" ||
    !Number.isInteger(role.rolconnlimit) ||
    (role.rolconnlimit as number) < 1 ||
    (role.rolconnlimit as number) > 6 ||
    role.rolcanlogin !== true ||
    ["rolsuper", "rolcreaterole", "rolcreatedb", "rolreplication", "rolbypassrls"].some(
      (flag) => role[flag] !== false
    )
  )
    throw new Error("job_database_identity_rejected");
}
