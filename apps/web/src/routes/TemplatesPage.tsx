import { Link } from "react-router-dom";

const TEMPLATE_GROUPS = [
  "Launch",
  "Social",
  "Education",
  "Product",
  "Internal",
];

const TEMPLATES = [
  {
    id: "launch-teaser",
    title: "Launch teaser",
    group: "Launch",
    length: "30s",
    aspect: "9:16",
    brief: "Fast hook, three proof points, product reveal, closing CTA.",
  },
  {
    id: "founder-update",
    title: "Founder update",
    group: "Internal",
    length: "60s",
    aspect: "16:9",
    brief: "Direct-to-camera outline with b-roll prompts and chapter beats.",
  },
  {
    id: "ugc-cutdown",
    title: "UGC cutdown",
    group: "Social",
    length: "20s",
    aspect: "9:16",
    brief: "Grab the strongest customer moment and package it for short-form.",
  },
  {
    id: "feature-demo",
    title: "Feature demo",
    group: "Product",
    length: "45s",
    aspect: "16:9",
    brief: "Problem, workflow, outcome, and polished product screenshots.",
  },
  {
    id: "how-to",
    title: "How-to lesson",
    group: "Education",
    length: "90s",
    aspect: "16:9",
    brief: "Step-by-step lesson with recap cards and clear visual anchors.",
  },
  {
    id: "event-recap",
    title: "Event recap",
    group: "Social",
    length: "45s",
    aspect: "1:1",
    brief: "Montage structure with attendee quotes and branded end slate.",
  },
];

export function TemplatesPage() {
  return (
    <main className="studio-secondary">
      <section className="studio-secondary-hero">
        <div>
          <span className="studio-secondary-eyebrow">Templates</span>
          <h1>Start from a proven cut structure</h1>
          <p>
            Pick a format and Popcorn Ready will prefill the creative brief,
            duration, aspect ratio, and beat shape for the new project flow.
          </p>
        </div>
        <Link className="studio-secondary-primary" to="/projects/new">
          Blank project
        </Link>
      </section>

      <nav className="studio-secondary-pills" aria-label="Template categories">
        {TEMPLATE_GROUPS.map((group) => (
          <span key={group}>{group}</span>
        ))}
      </nav>

      <section className="studio-template-grid" aria-label="Template gallery">
        {TEMPLATES.map((template) => (
          <article className="studio-template-card" key={template.id}>
            <div className="studio-template-preview" aria-hidden="true">
              <span>{template.aspect}</span>
            </div>
            <div className="studio-template-meta">
              <span>{template.group}</span>
              <span>{template.length}</span>
            </div>
            <h2>{template.title}</h2>
            <p>{template.brief}</p>
            <Link
              className="studio-secondary-action"
              to={`/projects/new?template=${template.id}`}
            >
              Use template
            </Link>
          </article>
        ))}
      </section>
    </main>
  );
}
