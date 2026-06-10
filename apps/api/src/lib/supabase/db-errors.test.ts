import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiError } from "../../core/errors";
import { databaseError, isMissingRow, throwDatabaseError } from "./db-errors";

test("isMissingRow recognizes PostgREST no-row responses", () => {
  assert.equal(isMissingRow({ code: "PGRST116" }), true);
  assert.equal(isMissingRow({ code: "23505" }), false);
  assert.equal(isMissingRow(null), false);
});

test("databaseError preserves operation and Supabase details in the API envelope", () => {
  const err = databaseError("store.createProject insert project", {
    code: "23503",
    message: "insert or update on table violates foreign key constraint",
    details: "Key is not present in table.",
    hint: "Check the workspace id.",
  });

  assert.equal(err.code, "database_error");
  assert.equal(err.status, 500);
  assert.equal(err.message, "Database operation failed: store.createProject insert project.");
  assert.deepEqual(err.details, {
    operation: "store.createProject insert project",
    dbCode: "23503",
    dbMessage: "insert or update on table violates foreign key constraint",
    dbDetails: "Key is not present in table.",
    dbHint: "Check the workspace id.",
  });
});

test("throwDatabaseError throws ApiError only when Supabase returned an error", () => {
  assert.doesNotThrow(() => throwDatabaseError("store.listProjects", null));

  assert.throws(
    () => throwDatabaseError("store.listProjects", { message: "connection failed" }),
    (err) => err instanceof ApiError && err.code === "database_error"
  );
});
