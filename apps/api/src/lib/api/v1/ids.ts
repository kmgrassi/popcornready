// Ephemeral request-correlation id only. Entity primary keys are DB-generated
// (uuid default gen_random_uuid()); inserts omit `id` and read it back.
export { newRequestId } from "@/core/ids";
