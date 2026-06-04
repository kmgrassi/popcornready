import { Route, Routes } from "react-router-dom";
import { AppLayout } from "./components/AppLayout";
import { GenerationCardsPage } from "./routes/dev/GenerationCardsPage";
import { AdminPage } from "./routes/AdminPage";
import { HomePage } from "./routes/HomePage";
import { LoginPage } from "./routes/LoginPage";
import { SignupPage } from "./routes/SignupPage";

// Route table for the SPA. Each page PR ports one former Next app route into
// apps/web/src/routes/* and adds exactly one child <Route> here.
export function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<HomePage />} />
        <Route path="/studio" element={<Placeholder name="Studio" />} />
        <Route path="/dev/generation-cards" element={<GenerationCardsPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="*" element={<Placeholder name="Not found" />} />
      </Route>
    </Routes>
  );
}

function Placeholder({ name }: { name: string }) {
  return (
    <main className="web-shell-main">
      <h1>Popcorn Ready</h1>
      <p className="muted">{name} is migrating from Next to Vite SPA.</p>
    </main>
  );
}
