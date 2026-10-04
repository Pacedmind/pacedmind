// npm run test:sql. No Docker, credentials, network or persisted database are used.
// See supabase/tests/auth-fixture.sql for the intentionally limited Auth fixture contract.
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (relative) => readFile(new URL(relative, root), "utf8");
const db = new PGlite();

function checkLegacyResults(message) {
  if (!message.startsWith("RESULTS (rolled back)\n") || /\b(?:FAIL|ERROR)\b/.test(message)) {
    throw new Error(message);
  }
  // The original SQL suite rolls back with an exception carrying observations. Check EVERY
  // `(want ...)`, including multiple expectations on one line and expected error codes.
  const expected = [...message.matchAll(/(\S+) \(want ([^)]+)\)/g)];
  const markers = [...message.matchAll(/\(want /g)].length;
  if (expected.length !== markers || markers < 100 || !message.includes("13b account rows left=0 (want 0)")) {
    throw new Error("The legacy SQL suite returned incomplete or unrecognized results.");
  }
  for (const [observation, token, want] of expected) {
    const actual = token.includes("=") ? token.slice(token.lastIndexOf("=") + 1) : token;
    if (actual !== want) throw new Error(`SQL security regression: ${observation}`);
  }
  const lines = message.trim().split("\n").filter((line) => /^\d/.test(line));
  return `${lines.length} result lines; ${expected.length} expected values matched; no FAIL/ERROR`;
}

try {
  await db.exec(await read("supabase/tests/auth-fixture.sql"));
  const migrations = (await readdir(new URL("supabase/migrations/", root))).filter((name) => name.endsWith(".sql")).sort();
  for (const name of migrations) {
    try {
      await db.exec(await read(`supabase/migrations/${name}`));
    } catch (error) {
      throw new Error(`Migration ${name} failed: ${error.message}`, { cause: error });
    }
  }
  console.log(`Applied ${migrations.length} migrations to isolated PostgreSQL WASM.`);

  let legacyResult;
  try {
    await db.exec(await read("supabase/tests/security.sql"));
  } catch (error) {
    legacyResult = checkLegacyResults(error.message);
  }
  if (!legacyResult) throw new Error("security.sql did not produce its rollback result.");
  console.log(`security.sql: ${legacyResult}.`);

  await db.exec(await read("supabase/tests/optional_mfa.sql"));
  console.log("optional_mfa.sql: all assertions passed; fixtures rolled back.");
  await db.exec(await read("supabase/tests/task_notes.sql"));
  console.log("task_notes.sql: display ownership, queue isolation, agent scope, delivery and quota assertions passed; fixtures rolled back.");
  const { rows } = await db.query("select count(*)::int as accounts from auth.users");
  if (rows[0].accounts !== 0) throw new Error("SQL test fixtures were not rolled back.");
  console.log("Auth HTTP/OAuth integration and hosted security advisors still require a Supabase test stack.");
} finally {
  await db.close();
}
