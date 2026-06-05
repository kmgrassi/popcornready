// Ephemeral, non-persisted correlation ids.
//
// There is no app-side primary-key minting here: every entity written to
// Postgres gets its id from the database (`uuid default gen_random_uuid()`), and
// inserts read the id back. The only id minted in app code is the per-request
// correlation id below, which is never persisted as a primary key (it rides in
// log lines and the error envelope's `requestId`).

export function newRequestId(): string {
  return "req_" + Math.random().toString(36).slice(2, 10);
}
