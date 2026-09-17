/**
 * middleware.ts -- the outer gate.
 *
 * Two jobs. It keeps the Supabase session cookie fresh so the adviser is not
 * logged out mid-afternoon, and it turns away unauthenticated requests before
 * any page renders.
 *
 * This runs in addition to requireUser() on each page, not instead of it.
 * Middleware alone is not a sufficient access control -- it is easy to add a
 * route that the matcher misses. The page-level guard is the real check.
 */

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

const PUBLIC_PATHS = ["/login", "/auth/callback", "/auth/signout"];

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet) => {
          toSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          toSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Refreshes the token if it is close to expiring, and writes the new cookie.
  const { data } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PATHS.some((p) => path.startsWith(p));

  if (!data.user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    // Remember where they were headed so login can return them there.
    url.searchParams.set("next", path);
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: [
    // Everything except Next's own assets and the favicon.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
