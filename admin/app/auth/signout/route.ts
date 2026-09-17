import { NextResponse, type NextRequest } from "next/server";
import { createAuthClient } from "@/lib/auth";

export async function POST(request: NextRequest) {
  const supabase = await createAuthClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(`${request.nextUrl.origin}/login`, { status: 303 });
}
