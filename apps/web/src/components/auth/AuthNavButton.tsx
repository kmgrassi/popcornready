import { Link } from "react-router-dom";
import { useAuth } from "./AuthProvider";

export function AuthNavButton() {
  const { status, user, signOut } = useAuth();

  if (status === "authenticated") {
    return (
      <button
        type="button"
        className="lp-nav-button"
        title={user?.email ?? "Signed in"}
        onClick={() => void signOut()}
      >
        Sign out
      </button>
    );
  }

  return <Link to="/login">Sign in</Link>;
}
