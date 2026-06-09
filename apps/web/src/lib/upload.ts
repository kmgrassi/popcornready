// Footage-upload helpers, lifted out of the retired NewProjectPage / Editor so
// the Source Footage step (PR 3) and the Studio shell share one implementation
// instead of re-deriving file metadata inline. PR 3 wires these to the real
// asset-upload endpoint; today they cover selection + local metadata, which is
// all the prompt-only / hybrid flow needs.

/** A locally selected footage file plus the metadata the wizard displays. */
export interface SelectedFootage {
  file: File;
  name: string;
  sizeBytes: number;
  /** Best-effort duration in seconds (4 for images, measured for video). */
  durationSec: number;
}

/** File input accept string for the footage picker. */
export const FOOTAGE_ACCEPT = "video/*,image/*,audio/*";

/**
 * Measure a clip's duration without uploading it. Images default to 4s;
 * video/audio are probed via a transient media element. Resolves 0 on error so
 * a single bad file never blocks selection.
 */
export function readDuration(file: File): Promise<number> {
  if (file.type.startsWith("image/")) return Promise.resolve(4);
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const media = document.createElement(
      file.type.startsWith("audio/") ? "audio" : "video",
    );
    media.preload = "metadata";
    media.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(media.duration) ? media.duration : 0);
    };
    media.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(0);
    };
    media.src = url;
  });
}

/** Read a FileList from a picker into SelectedFootage entries with durations. */
export async function readSelectedFootage(
  files: FileList | File[] | null,
): Promise<SelectedFootage[]> {
  const list = files ? Array.from(files) : [];
  return Promise.all(
    list.map(async (file) => ({
      file,
      name: file.name,
      sizeBytes: file.size,
      durationSec: await readDuration(file),
    })),
  );
}
