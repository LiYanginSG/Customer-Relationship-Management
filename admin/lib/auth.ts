/**
 * auth.ts -- who is allowed in.
 *
 * This portal shows an entire book of clients: names, dates of birth, incomes,
 * policies and private meeting notes. It sits on a public URL. So the rule is
 * strict and simple:
 *
 *   1. You must have proved you own an email address (Supabase magic link).
 *   2. That address must be on an allowlist held in an environment variable.
 *
 * An empty allowlist lets NOBODY in. Failing closed is the only safe default:
 * a misconfigured deploy should be useless, not open.
 */

import { redirect } from "next/navigation";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/** Addresses permitted to sign in. Comma separated, case-insensitive. */
export function allowedEmails(): string[] {
  return (process.env.ADMIN_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowedEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const allowed = allowedEmails();
  if (allowed.length === 0) return false;
  return allowed.includes(email.toLowerCase());
}

/**
 * A Supabase client bound to the visitor's cookies, used ONLY to read who they
 * are. It carries the publishable (anon) key, which is safe here because every
 * table is behind deny-by-default RLS -- this client can read no business data.
 */
export async function createAuthClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (toSet) => {
          try {
            toSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component, where cookies are read-only.
            // Middleware refreshes the session instead, so this is safe to skip.
          }
        },
      },
    },
  );
}

export interface SignedInUser {
  id: string;
  email: string;
}

/** The signed-in, allowlisted user, or null. Never throws. */
export async function currentUser(): Promise<SignedInUser | null> {
  const supabase = await createAuthClient();

  // getUser() revalidates the token with Supabase. getSession() would trust
  // the cookie as-is, which is forgeable -- never use it for an access check.
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user?.email) return null;
  if (!isAllowedEmail(data.user.email)) return null;

  return { id: data.user.id, email: data.user.email };
}

/**
 * Guard for every page and action that touches client data. Call it first,
 * before any query. It redirects rather than returning, so a forgotten check
 * cannot silently fall through to rendering data.
 */
export async function requireUser(): Promise<SignedInUser> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}
