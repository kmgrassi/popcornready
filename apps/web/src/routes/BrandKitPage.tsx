import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

const FONT_OPTIONS = ["Inter", "Avenir", "Georgia", "IBM Plex Sans", "System"];
const TONE_OPTIONS = ["Warm cinematic", "Clean product", "Documentary", "Bold social"];

export function BrandKitPage() {
  const [brandName, setBrandName] = useState("Popcorn Ready");
  const [primaryColor, setPrimaryColor] = useState("#ff6a3d");
  const [font, setFont] = useState(FONT_OPTIONS[0]);
  const [tone, setTone] = useState(TONE_OPTIONS[0]);

  const promptSummary = useMemo(
    () =>
      `${brandName} videos should feel ${tone.toLowerCase()}, use ${font}, and lean on ${primaryColor} as the primary accent.`,
    [brandName, font, primaryColor, tone],
  );

  return (
    <main className="studio-secondary">
      <section className="studio-secondary-hero">
        <div>
          <span className="studio-secondary-eyebrow">Brand Kit</span>
          <h1>Set creative defaults once</h1>
          <p>
            Capture the visual rules the agent should apply to new projects:
            name, accent color, type, voice, and reusable end-frame guidance.
          </p>
        </div>
        <Link className="studio-secondary-primary" to="/projects/new">
          Create with kit
        </Link>
      </section>

      <section className="studio-brand-layout">
        <form className="studio-brand-form">
          <label>
            Brand name
            <input
              onChange={(event) => setBrandName(event.target.value)}
              type="text"
              value={brandName}
            />
          </label>
          <label>
            Primary accent
            <input
              onChange={(event) => setPrimaryColor(event.target.value)}
              type="color"
              value={primaryColor}
            />
          </label>
          <label>
            Preferred type
            <select onChange={(event) => setFont(event.target.value)} value={font}>
              {FONT_OPTIONS.map((option) => (
                <option key={option}>{option}</option>
              ))}
            </select>
          </label>
          <label>
            Creative tone
            <select onChange={(event) => setTone(event.target.value)} value={tone}>
              {TONE_OPTIONS.map((option) => (
                <option key={option}>{option}</option>
              ))}
            </select>
          </label>
          <label>
            End-frame guidance
            <textarea defaultValue="Show the logo, one concise CTA, and a clean product screenshot." />
          </label>
        </form>

        <aside className="studio-brand-preview">
          <div className="studio-brand-frame" style={{ borderColor: primaryColor }}>
            <span style={{ background: primaryColor }} />
            <h2 style={{ fontFamily: font === "System" ? undefined : font }}>
              {brandName || "Untitled brand"}
            </h2>
            <p>{tone}</p>
          </div>
          <div className="studio-brand-prompt">
            <h2>Agent default</h2>
            <p>{promptSummary}</p>
          </div>
        </aside>
      </section>
    </main>
  );
}
