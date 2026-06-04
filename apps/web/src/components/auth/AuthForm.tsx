import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { LogoMark } from "../LogoMark";
import { clearAllSupabaseAuthStorage, getSupabaseClient } from "../../lib/supabase/browser";
import { useAuth } from "./AuthProvider";

type AuthFormProps = {
  mode: "login" | "signup";
};

export function AuthForm({ mode }: AuthFormProps) {
  const navigate = useNavigate();
  const { status, error, configured, signIn, signUp } = useAuth();
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const loading = status === "loading";
  const isSignup = mode === "signup";

  useEffect(() => {
    if (!configured) {
      setReady(true);
      return;
    }

    if (status === "loading") {
      setReady(false);
      return;
    }

    if (status === "authenticated") {
      setReady(true);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        await getSupabaseClient().auth.signOut({ scope: "local" });
      } catch {
        // Ignore transient sign-out errors while clearing stale local sessions.
      } finally {
        clearAllSupabaseAuthStorage();
        if (!cancelled) setReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [configured, status]);

  useEffect(() => {
    if (status === "authenticated") navigate("/studio", { replace: true });
  }, [navigate, status]);

  async function submit() {
    if (!ready || loading || !email.trim() || !password) return;
    if (isSignup) await signUp(email.trim(), password);
    else await signIn(email.trim(), password);
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <Link to="/" className="auth-brand">
          <LogoMark className="auth-brand-mark" />
          <span>Popcorn Ready</span>
        </Link>

        <div className="auth-heading">
          <h1>{isSignup ? "Create your account" : "Sign in"}</h1>
          <p>
            {isSignup
              ? "Start saving projects, assets, and finished videos."
              : "Continue to your video studio."}
          </p>
        </div>

        {!configured && (
          <p className="auth-error">
            Supabase login is not configured yet. Set the public Supabase URL
            and anon key, then restart the app.
          </p>
        )}

        <div className="auth-fields">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && void submit()}
            disabled={!ready || loading || !configured}
          />

          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete={isSignup ? "new-password" : "current-password"}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && void submit()}
            disabled={!ready || loading || !configured}
          />
        </div>

        {error && <p className="auth-error">{error}</p>}

        <button
          className="auth-submit"
          type="button"
          onClick={() => void submit()}
          disabled={!ready || loading || !configured || !email.trim() || !password}
        >
          {!ready
            ? "Preparing..."
            : loading
              ? isSignup
                ? "Creating..."
                : "Signing in..."
              : isSignup
                ? "Create account"
                : "Sign in"}
        </button>

        <p className="auth-switch">
          {isSignup ? "Already have an account?" : "Don't have an account?"}{" "}
          <Link to={isSignup ? "/login" : "/signup"}>
            {isSignup ? "Sign in" : "Sign up"}
          </Link>
        </p>
      </section>
    </main>
  );
}
