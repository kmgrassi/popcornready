import type { ReactNode } from "react";
import type { User } from "@supabase/supabase-js";
import { Link, Navigate } from "react-router-dom";
import { useAuth } from "./AuthProvider";

const ADMIN_ROLES = new Set(["admin", "owner"]);

function valuesFromClaim(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return [];
}

export function hasAdminClaim(user: User | null): boolean {
  if (!user) return false;

  const claims = [
    ...valuesFromClaim(user.app_metadata?.role),
    ...valuesFromClaim(user.app_metadata?.roles),
    ...valuesFromClaim(user.app_metadata?.workspace_role),
    ...valuesFromClaim(user.user_metadata?.role),
    ...valuesFromClaim(user.user_metadata?.roles),
    ...valuesFromClaim(user.user_metadata?.workspace_role),
  ];

  return claims.some((claim) => ADMIN_ROLES.has(claim.toLowerCase()));
}

export function canAccessAdminSurface({
  status,
  user,
}: Pick<ReturnType<typeof useAuth>, "status" | "user">): boolean {
  if (status === "disabled") return import.meta.env.DEV;
  return status === "authenticated" && hasAdminClaim(user);
}

export function AdminRoute({ children }: { children: ReactNode }) {
  const auth = useAuth();

  if (auth.status === "loading") {
    return (
      <main className="auth-page">
        <section className="auth-card">
          <h1>Checking access</h1>
          <p className="muted">Verifying your admin session.</p>
        </section>
      </main>
    );
  }

  if (canAccessAdminSurface(auth)) {
    return <>{children}</>;
  }

  if (auth.status === "unauthenticated") {
    return <Navigate to="/login" replace />;
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <h1>Admin access required</h1>
        <p className="auth-switch">
          This workbench is limited to workspace admins.{" "}
          <Link to="/evals">Return to eval suites</Link>
        </p>
      </section>
    </main>
  );
}
