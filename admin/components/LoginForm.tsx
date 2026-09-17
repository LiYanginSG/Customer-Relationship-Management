"use client";

import { useState } from "react";
import { createBrowserClient } from "@supabase/ssr";

/**
 * The only Client Component that talks to Supabase directly. It uses the
 * publishable (anon) key, which is designed to be public and can read nothing
 * -- every table is behind deny-by-default row-level security.
 */
export function LoginForm({ next }: { next: string }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    setState("sending");
    setError(null);

    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );

    const redirectTo =
      `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: redirectTo,
        // Nobody signs up here. Accounts are created by the adviser in
        // Supabase, and the email must also be on the allowlist.
        shouldCreateUser: false,
      },
    });

    if (error) {
      setError(error.message);
      setState("error");
      return;
    }
    setState("sent");
  }

  if (state === "sent") {
    return (
      <div className="text-center py-2">
        <p className="text-sm font-medium">Check your email</p>
        <p className="mt-1.5 text-sm text-ink-soft">
          A sign-in link is on its way to {email}. It expires shortly, so use it soon.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={send} className="space-y-4">
      <div>
        <label htmlFor="email" className="label">Email address</label>
        <input
          id="email"
          type="email"
          required
          autoFocus
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="input"
          placeholder="you@example.com"
        />
      </div>

      {error && <p className="text-sm text-alert">{error}</p>}

      <button type="submit" disabled={state === "sending"} className="btn-primary w-full">
        {state === "sending" ? "Sending…" : "Send sign-in link"}
      </button>
    </form>
  );
}
