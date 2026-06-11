import { getSupabaseAdmin } from "../src/lib/supabase/admin";
import { bucketForVisibility } from "../src/lib/storage/config";

type Visibility = "public" | "private";

interface AssetStorageBackfillRow {
  id: string;
  project_id: string;
  workspace_id: string;
  visibility: Visibility;
  storage_key: string | null;
  storage_bucket: string | null;
  projects: { visibility: Visibility } | null;
}

const write = process.argv.includes("--write");

const db = getSupabaseAdmin();
const { data, error } = await db
  .from("assets")
  .select("id,project_id,workspace_id,visibility,storage_key,storage_bucket,projects(visibility)")
  .or("storage_key.is.null,storage_bucket.is.null")
  .order("created_at", { ascending: true });

if (error) throw error;

const rows = ((data ?? []) as unknown as AssetStorageBackfillRow[]).filter(
  (row) => row.storage_key || row.storage_bucket
);
const missingBytes = ((data ?? []) as unknown as AssetStorageBackfillRow[]).filter(
  (row) => !row.storage_key && !row.storage_bucket
);

let updateCount = 0;
for (const row of rows) {
  if (!row.storage_key || row.storage_bucket) continue;
  const effectiveVisibility =
    row.visibility === "public" && row.projects?.visibility === "public"
      ? "public"
      : "private";
  const storageBucket = bucketForVisibility(effectiveVisibility);
  updateCount += 1;
  console.log(
    `${write ? "update" : "would update"} ${row.id}: storage_bucket=${storageBucket}`
  );
  if (write) {
    const update = await db
      .from("assets")
      .update({ storage_bucket: storageBucket })
      .eq("id", row.id);
    if (update.error) throw update.error;
  }
}

console.log(
  JSON.stringify(
    {
      mode: write ? "write" : "dry-run",
      rowsNeedingBucket: updateCount,
      rowsMissingBytes: missingBytes.length,
    },
    null,
    2
  )
);
