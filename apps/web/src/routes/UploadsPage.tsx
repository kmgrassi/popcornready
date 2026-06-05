import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

type UploadItem = {
  id: string;
  name: string;
  size: number;
  type: string;
};

function formatBytes(bytes: number) {
  if (bytes === 0) {
    return "0 KB";
  }

  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function UploadsPage() {
  const [uploads, setUploads] = useState<UploadItem[]>([]);

  const totalSize = useMemo(
    () => uploads.reduce((sum, upload) => sum + upload.size, 0),
    [uploads],
  );

  return (
    <main className="studio-secondary">
      <section className="studio-secondary-hero">
        <div>
          <span className="studio-secondary-eyebrow">Uploads</span>
          <h1>Keep source clips ready for the agent</h1>
          <p>
            Stage clips, references, and raw footage before creating a project.
            Cloud persistence will attach this library to the workspace API.
          </p>
        </div>
        <Link className="studio-secondary-primary" to="/projects/new">
          New project
        </Link>
      </section>

      <section className="studio-upload-drop">
        <div>
          <h2>Add footage</h2>
          <p>Drag support lands with persisted uploads; select files to stage a local batch now.</p>
        </div>
        <label className="studio-upload-button">
          Choose files
          <input
            accept="audio/*,image/*,video/*"
            multiple
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              setUploads((current) => [
                ...files.map((file) => ({
                  id: `${file.name}-${file.size}-${file.lastModified}`,
                  name: file.name,
                  size: file.size,
                  type: file.type || "Unknown",
                })),
                ...current,
              ]);
              event.currentTarget.value = "";
            }}
            type="file"
          />
        </label>
      </section>

      <section className="studio-secondary-stats" aria-label="Upload summary">
        <div>
          <strong>{uploads.length}</strong>
          <span>staged files</span>
        </div>
        <div>
          <strong>{formatBytes(totalSize)}</strong>
          <span>selected locally</span>
        </div>
        <div>
          <strong>Workspace</strong>
          <span>destination</span>
        </div>
      </section>

      <section className="studio-upload-list" aria-label="Staged uploads">
        {uploads.length === 0 ? (
          <div className="studio-secondary-empty">
            <h2>No uploads staged yet</h2>
            <p>
              Add source clips here, then use them from the New Project flow when
              the upload library is backed by the API.
            </p>
          </div>
        ) : (
          uploads.map((upload) => (
            <article className="studio-upload-row" key={upload.id}>
              <span className="studio-upload-kind">{upload.type.split("/")[0]}</span>
              <div>
                <h2>{upload.name}</h2>
                <p>{upload.type}</p>
              </div>
              <span>{formatBytes(upload.size)}</span>
              <button
                className="secondary compact"
                onClick={() =>
                  setUploads((current) =>
                    current.filter((item) => item.id !== upload.id),
                  )
                }
                type="button"
              >
                Remove
              </button>
            </article>
          ))
        )}
      </section>
    </main>
  );
}
