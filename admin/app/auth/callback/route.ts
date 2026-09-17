/**
 * The link in the login email lands here.
 *
 * Supabase gives us a one-time code; we exchange it for a session. Then -- and
 * this is the part that matters -- we check the email against the allowlist.
 * Anyone can ask Supabase for a magic link. Only allowlisted addresses get in.
 */

import { NextResponse, type NextRequest } from "next/server";
import { createAuthClient, isAllowedEmail } from "@/lib/auth";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`);
  }

  const supabase = await createAuthClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !data.user?.email) {
    return NextResponse.redirect(`${origin}/login?error=exchange_failed`);
  }

  if (!isAllowedEmail(data.user.email)) {
    // Signed in with Supabase, but not permitted here. End the session so a
    // stale cookie cannot linger on their browser.
    await supabase.auth.signOut();
    return NextResponse.redirect(`${origin}/login?error=not_allowed`);
  }

  // Only accept an internal destination -- an open redirect here would let a
  // crafted login link bounce the adviser to an attacker's page.
  const destination = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  return NextResponse.redirect(`${origin}${destination}`);
}
