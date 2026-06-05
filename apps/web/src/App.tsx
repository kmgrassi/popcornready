import { Navigate, Route, Routes } from "react-router-dom";
import { AppLayout } from "./components/AppLayout";
import { AdminRoute } from "./components/auth/AdminRoute";
import { useAuth } from "./components/auth/AuthProvider";
import { RunProgressPage } from "./routes/RunProgressPage";
import { StudioPage } from "./routes/StudioPage";
import { GenerationCardsPage } from "./routes/dev/GenerationCardsPage";
import { AdminPage } from "./routes/AdminPage";
import { AdminEvalsPage } from "./routes/AdminEvalsPage";
import { EvalsPage } from "./routes/EvalsPage";
import { HomePage } from "./routes/HomePage";
import { LoginPage } from "./routes/LoginPage";
import { SignupPage } from "./routes/SignupPage";

// Route table for the SPA. Each page PR ports one former Next app route into
// apps/web/src/routes/* and adds exactly one child <Route> here.
export function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<LandingRoute />} />
        <Route path="/dashboard" element={<DashboardEntryPage />} />
        <Route path="/studio" element={<StudioPage />} />
        <Route path="/dev/generation-cards" element={<GenerationCardsPage />} />
        <Route path="/evals" element={<EvalsPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route
          path="/admin/evals"
          element={
            <AdminRoute>
              <AdminEvalsPage />
            </AdminRoute>
          }
        />
        <Route path="/projects/:projectId/runs/:runId" element={<RunProgressPage />} />
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

function LandingRoute() {
  const { status } = useAuth();

  if (status === "disabled" || status === "authenticated") {
    return <Navigate to="/dashboard" replace />;
  }

  return <HomePage />;
}

function DashboardEntryPage() {
  return (
    <main className="web-shell-main">
      <h1>Dashboard</h1>
      <p className="muted">
        Your dashboard is migrating into the Vite app. Use the studio while the
        dashboard views finish landing.
      </p>
    </main>
  );
}
