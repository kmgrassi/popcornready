type WorkspaceStubPageProps = {
  title: string;
  eyebrow: string;
  description: string;
};

export function WorkspaceStubPage({ title, eyebrow, description }: WorkspaceStubPageProps) {
  return (
    <main className="workspace-stub-page">
      <section className="workspace-stub-panel">
        <p className="workspace-stub-eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p>{description}</p>
      </section>
    </main>
  );
}
