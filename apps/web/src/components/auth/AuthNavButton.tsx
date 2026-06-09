import { Link } from "react-router-dom";
import { useAuth } from "./AuthProvider";

export function AuthNavButton() {
  const { status, user } = useAuth();

  // Don't flash "Sign in" before the session resolves.
  if (status === "loading") {
    return null;
  }

  // Signed in (or local/no-auth mode): link into the app instead of "Sign in".
  // Sign-out lives in the dashboard account menu.
  if (status === "authenticated" || status === "disabled") {
    return (
      <Link to="/dashboard" title={user?.email ?? "Go to dashboard"}>
        Dashboard
      </Link>
    );
  }

  return <Link to="/login">Sign in</Link>;
}
