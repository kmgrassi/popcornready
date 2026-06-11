import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import {
  AppLayout,
  AuthenticatedAppLayout,
  RootLayout,
} from "./components/AppLayout";
import { AdminRoute } from "./components/auth/AdminRoute";
import { RunProgressPage } from "./routes/RunProgressPage";
import { StudioPage } from "./routes/StudioPage";
import { StoryboardPage } from "./routes/StoryboardPage";
import { GenerationCardsPage } from "./routes/dev/GenerationCardsPage";
import { AdminPage } from "./routes/AdminPage";
import { AdminEvalsPage } from "./routes/AdminEvalsPage";
import { BrandKitPage } from "./routes/BrandKitPage";
import { HomePage } from "./routes/HomePage";
import { LaunchpadPage } from "./routes/LaunchpadPage";
import { LibraryPage } from "./routes/LibraryPage";
import { LoginPage } from "./routes/LoginPage";
import { ProjectWatchPage } from "./routes/ProjectWatchPage";
import { SignupPage } from "./routes/SignupPage";
import { SettingsPage } from "./routes/SettingsPage";
import { TemplatesPage } from "./routes/TemplatesPage";
import { UploadsPage } from "./routes/UploadsPage";

// Route table for the SPA. Each page PR ports one former Next app route into
// apps/web/src/routes/* and adds exactly one child <Route> here.
export function App() {
  return (
    <Routes>
      <Route element={<RootLayout />}>
        <Route element={<AppLayout />}>
          <Route index element={<HomePage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
        </Route>

        <Route element={<AuthenticatedAppLayout />}>
          <Route path="/dashboard" element={<LaunchpadPage />} />
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/library/:tab" element={<LibraryPage />} />
          <Route path="/projects" element={<RedirectWithSearch to="/library/projects" />} />
          {/* The standalone create wizard is retired — Studio owns the full
              flow. Preserve any /projects/new deep links as a redirect. */}
          <Route path="/projects/new" element={<Navigate to="/studio" replace />} />
          <Route path="/runs" element={<RedirectWithSearch to="/library/runs" />} />
          <Route path="/assets" element={<RedirectWithSearch to="/library/assets" />} />
          <Route path="/outputs" element={<RedirectWithSearch to="/library/outputs" />} />
          <Route path="/studio" element={<StudioPage />} />
          <Route path="/uploads" element={<UploadsPage />} />
          <Route path="/templates" element={<TemplatesPage />} />
          <Route path="/brand" element={<BrandKitPage />} />
          <Route path="/storyboard" element={<Navigate to="/library" replace />} />
          <Route
            path="/projects/:projectId/storyboard"
            element={<StoryboardPage />}
          />
          <Route
            path="/projects/:projectId/watch"
            element={<ProjectWatchPage />}
          />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/dev/generation-cards" element={<GenerationCardsPage />} />
          <Route path="/evals" element={<RedirectWithSearch to="/library/evals" />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route
            path="/admin/evals"
            element={
              <AdminRoute>
                <AdminEvalsPage />
              </AdminRoute>
            }
          />
          <Route
            path="/projects/:projectId/runs/:runId"
            element={<RunProgressPage />}
          />
        </Route>

        <Route element={<AppLayout />}>
          <Route path="*" element={<Placeholder name="Not found" />} />
        </Route>
      </Route>
    </Routes>
  );
}

function RedirectWithSearch({ to }: { to: string }) {
  const location = useLocation();
  return <Navigate to={`${to}${location.search}`} replace />;
}

function Placeholder({ name }: { name: string }) {
  return (
    <main className="web-shell-main">
      <h1>Popcorn Ready</h1>
      <p className="muted">{name} is migrating from Next to Vite SPA.</p>
    </main>
  );
}
