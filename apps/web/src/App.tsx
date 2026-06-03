import { Route, Routes } from "react-router-dom";

// Route table for the SPA. Pages are ported from the former Next app router
// (src/app/*) into src/routes/* as the migration proceeds (see MIGRATION.md).
export function App() {
  return (
    <Routes>
      <Route path="/" element={<Placeholder name="Home" />} />
      <Route path="/studio" element={<Placeholder name="Studio" />} />
      <Route path="/login" element={<Placeholder name="Login" />} />
      <Route path="/signup" element={<Placeholder name="Signup" />} />
      <Route path="*" element={<Placeholder name="Not found" />} />
    </Routes>
  );
}

function Placeholder({ name }: { name: string }) {
  return (
    <main style={{ fontFamily: "system-ui", padding: 48 }}>
      <h1>Popcorn Ready</h1>
      <p>{name} — migrating from Next to Vite SPA.</p>
    </main>
  );
}
