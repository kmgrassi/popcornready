import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { User } from "@supabase/supabase-js";
import {
  clearAllSupabaseAuthStorage,
  clearBrowserSessionState,
  clearOtherSupabaseAuthStorage,
  getSupabaseClient,
  resolveBrowserSupabaseConfig,
} from "../../lib/supabase/browser";

type AuthStatus = "loading" | "disabled" | "unauthenticated" | "authenticated";

type AuthContextValue = {
  status: AuthStatus;
  user: User | null;
  error: string | null;
  configured: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  clearError: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

// Turn a Supabase auth error into a user-facing message. Falls back to the raw
// message so nothing is hidden; only the most common codes get friendlier copy.
function describeAuthError(err: unknown): string {
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code?: unknown }).code ?? "")
      : "";
  if (code === "email_not_confirmed") {
    return "Your email isn't confirmed yet. Check your inbox for the verification link, then sign in.";
  }
  if (code === "invalid_credentials") {
    return "Incorrect email or password.";
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);
  const configured = Boolean(resolveBrowserSupabaseConfig());

  useEffect(() => {
    if (!configured) {
      setStatus("disabled");
      return;
    }

    clearOtherSupabaseAuthStorage();
    const supabase = getSupabaseClient();
    let mounted = true;

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      setUser(session?.user ?? null);
      setStatus(session?.user ? "authenticated" : "unauthenticated");
      // Only clear a surfaced error on a *successful* auth. A SIGNED_OUT event —
      // e.g. AuthForm defensively clearing a stale local session after a failed
      // sign-in — must not wipe the sign-in/sign-up error before the user reads it.
      if (session?.user) setError(null);
    });

    void supabase.auth
      .getSession()
      .then(({ data, error: sessionError }) => {
        if (!mounted) return;
        if (sessionError) throw sessionError;
        setUser(data.session?.user ?? null);
        setStatus(data.session?.user ? "authenticated" : "unauthenticated");
      })
      .catch((err) => {
        if (!mounted) return;
        setUser(null);
        setStatus("unauthenticated");
        setError(describeAuthError(err));
      });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [configured]);

  const signIn = useCallback(async (email: string, password: string) => {
    setError(null);
    setStatus("loading");
    try {
      clearAllSupabaseAuthStorage();
      const { data, error: signInError } =
        await getSupabaseClient().auth.signInWithPassword({ email, password });
      if (signInError || !data.session?.user) {
        throw signInError || new Error("No Supabase session returned.");
      }
      setUser(data.session.user);
      setStatus("authenticated");
    } catch (err) {
      setUser(null);
      setStatus("unauthenticated");
      setError(describeAuthError(err));
    }
  }, []);

  const signUp = useCallback(async (email: string, password: string) => {
    setError(null);
    setStatus("loading");
    try {
      clearAllSupabaseAuthStorage();
      const { data, error: signUpError } = await getSupabaseClient().auth.signUp({
        email,
        password,
      });
      if (signUpError) throw signUpError;

      if (data.session?.user) {
        setUser(data.session.user);
        setStatus("authenticated");
        return;
      }

      setUser(null);
      setStatus("unauthenticated");
      setError("Sign-up complete. Check your email for verification.");
    } catch (err) {
      setUser(null);
      setStatus("unauthenticated");
      setError(describeAuthError(err));
    }
  }, []);

  const signOut = useCallback(async () => {
    setError(null);
    if (configured) {
      try {
        const supabase = getSupabaseClient();
        await supabase.auth.signOut();
      } catch {
        // Still clear browser state so a stale local session cannot keep the
        // user signed in after an auth/network failure.
      }
    }
    clearAllSupabaseAuthStorage();
    clearBrowserSessionState();
    setUser(null);
    setStatus("unauthenticated");
  }, [configured]);

  // Lets a view drop a stale surfaced error without a status change — e.g. the
  // auth form clears the previous message when the user switches login <-> signup.
  const clearError = useCallback(() => setError(null), []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, error, configured, signIn, signUp, signOut, clearError }),
    [status, user, error, configured, signIn, signUp, signOut, clearError]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used within AuthProvider.");
  return value;
}
