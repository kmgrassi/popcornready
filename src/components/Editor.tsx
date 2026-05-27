"use client";

import React, { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  AspectRatio,
  Clip,
  Project,
  Timeline,
  segmentDurationSec,
  timelineDurationSec,
} from "@/lib/types";

// Player relies on browser APIs — never SSR it.
const Preview = dynamic(() => import("./Preview"), { ssr: false });

async function readDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(v.duration) ? v.duration : 0);
    };
    v.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(0);
    };
    v.src = url;
  });
}

export function Editor() {
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [exportUrl, setExportUrl] = useState<string | null>(null);

  // generate form
  const [goal, setGoal] = useState("");
  const [targetLength, setTargetLength] = useState(30);
  const [style, setStyle] = useState("fast-paced social ad");
  const [aspect, setAspect] = useState<AspectRatio>("9:16");

  // upload form
  const [desc, setDesc] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  // chat
  const [message, setMessage] = useState("");

  useEffect(() => {
    fetch("/api/project")
      .then((r) => r.json())
      .then((d) => setProject(d.project))
      .catch((e) => setError(String(e)));
  }, []);

  const clips = project?.clips ?? [];
  const timeline = project?.timeline ?? null;

  async function handleUpload() {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setError(null);
    setBusy("Uploading clip…");
    try {
      const durationSec = await readDuration(file);
      const fd = new FormData();
      fd.append("file", file);
      fd.append("durationSec", String(durationSec));
      fd.append("description", desc);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");
      setProject(data.project);
      setDesc("");
      if (fileRef.current) fileRef.current.value = "";
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function handleGenerate() {
    setError(null);
    setExportUrl(null);
    setBusy("Planning beats, selecting clips, running the critic…");
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal,
          targetLengthSec: targetLength,
          style,
          aspectRatio: aspect,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Generation failed");
      setProject(data.project);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function handleRevise() {
    if (!message.trim()) return;
    setError(null);
    setExportUrl(null);
    const msg = message;
    setMessage("");
    setBusy("Revising the cut…");
    try {
      const res = await fetch("/api/revise", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Revision failed");
      setProject(data.project);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function handleExport() {
    setError(null);
    setBusy("Rendering MP4 with Remotion (first run downloads a browser)…");
    try {
      const res = await fetch("/api/export", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Export failed");
      setExportUrl(data.url);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  const clipById = Object.fromEntries(clips.map((c) => [c.id, c]));

  return (
    <div className="app">
      {/* LEFT: assets + brief */}
      <div className="col">
        <h1>aividi</h1>
        <p className="sub">AI-native video editor — clips + a goal → an editable cut.</p>

        {error && <div className="error">{error}</div>}
        {busy && <div className="spinner">⏳ {busy}</div>}

        <h2>1 · Upload clips</h2>
        <input ref={fileRef} type="file" accept="video/*" />
        <label>Description (what's in this clip — helps the AI choose)</label>
        <input
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="e.g. close-up of product, smiling face, city b-roll"
        />
        <div style={{ marginTop: 8 }}>
          <button onClick={handleUpload} disabled={!!busy}>
            Add clip
          </button>
        </div>

        <h2>Library ({clips.length})</h2>
        {clips.length === 0 && (
          <p className="muted">No clips yet. Upload a few to get started.</p>
        )}
        {clips.map((c: Clip) => (
          <div className="card clip" key={c.id}>
            <video src={c.url} muted preload="metadata" />
            <div className="meta">
              <div className="fn">{c.filename}</div>
              <div className="muted">{c.durationSec.toFixed(1)}s</div>
              <div className="muted">{c.description || "no description"}</div>
            </div>
          </div>
        ))}

        <h2>2 · Brief</h2>
        <label>Creative goal / script</label>
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="e.g. A 30s ad that hooks fast, shows the problem, demos the product, and ends with a strong CTA."
        />
        <div className="row" style={{ marginTop: 8 }}>
          <div style={{ flex: 1 }}>
            <label>Length (s)</label>
            <input
              type="number"
              value={targetLength}
              onChange={(e) => setTargetLength(Number(e.target.value))}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label>Aspect</label>
            <select
              value={aspect}
              onChange={(e) => setAspect(e.target.value as AspectRatio)}
            >
              <option value="9:16">9:16</option>
              <option value="16:9">16:9</option>
              <option value="1:1">1:1</option>
            </select>
          </div>
        </div>
        <label>Style</label>
        <input value={style} onChange={(e) => setStyle(e.target.value)} />
        <div style={{ marginTop: 10 }}>
          <button
            onClick={handleGenerate}
            disabled={!!busy || clips.length === 0 || !goal.trim()}
          >
            Generate rough cut
          </button>
        </div>
      </div>

      {/* CENTER: preview + export */}
      <div className="col center">
        <h2 style={{ alignSelf: "flex-start" }}>Preview</h2>
        <Preview timeline={timeline} clips={clips} />
        {timeline && timeline.segments.length > 0 && (
          <div style={{ marginTop: 12, textAlign: "center" }}>
            <div className="muted" style={{ marginBottom: 8 }}>
              {timeline.segments.length} segments ·{" "}
              {timelineDurationSec(timeline).toFixed(1)}s · {timeline.aspectRatio}
            </div>
            <button className="secondary" onClick={handleExport} disabled={!!busy}>
              Export MP4
            </button>
            {exportUrl && (
              <div style={{ marginTop: 10 }}>
                <a href={exportUrl} target="_blank" rel="noreferrer">
                  ⬇ Download render
                </a>
              </div>
            )}
          </div>
        )}

        {project?.plan && (
          <div style={{ alignSelf: "stretch", marginTop: 20 }}>
            <h2>Edit plan</h2>
            <div className="muted" style={{ marginBottom: 6 }}>
              {project.plan.style} · {project.plan.targetLengthSec}s
            </div>
            {project.plan.beats.map((b, i) => (
              <span className="pill" key={i}>
                {b.name} ~{b.durationSec}s
              </span>
            ))}
          </div>
        )}
      </div>

      {/* RIGHT: timeline, critic, chat */}
      <div className="col">
        <h2>Timeline</h2>
        {!timeline && <p className="muted">Generate a cut to see the timeline.</p>}
        {timeline &&
          timeline.segments.map((s, i) => (
            <div className="segment" key={s.id}>
              <span className="idx">{i + 1}</span>
              <div style={{ minWidth: 0 }}>
                <div>
                  <b>{s.role}</b> ·{" "}
                  {clipById[s.clipId]?.filename || s.clipId} ·{" "}
                  {segmentDurationSec(s).toFixed(1)}s
                </div>
                <div className="muted">
                  in {s.sourceInSec.toFixed(1)}s → out {s.sourceOutSec.toFixed(1)}s
                </div>
                {s.reason && <div className="muted">{s.reason}</div>}
              </div>
            </div>
          ))}

        {project?.critic && (
          <>
            <h2>Critic</h2>
            <div className="scores">
              {Object.entries(project.critic.scores).map(([k, v]) => (
                <div className="score" key={k}>
                  <span className="muted">{k.replace(/_/g, " ")}</span>
                  <b>{v}</b>
                </div>
              ))}
            </div>
            <p className="muted" style={{ marginTop: 8 }}>
              {project.critic.summary}
            </p>
          </>
        )}

        <h2>Revise (chat)</h2>
        <div className="chat">
          {(project?.chat ?? []).length === 0 && (
            <p className="muted">
              Ask for changes: “make it punchier”, “use less talking head”, “shorten
              to 15s”, “add captions”.
            </p>
          )}
          {(project?.chat ?? []).map((m, i) => (
            <div className={`msg ${m.role}`} key={i}>
              {m.content}
            </div>
          ))}
        </div>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Make the hook punchier and add captions…"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleRevise();
          }}
        />
        <div style={{ marginTop: 8 }}>
          <button onClick={handleRevise} disabled={!!busy || !timeline}>
            Send revision
          </button>
        </div>
      </div>
    </div>
  );
}
