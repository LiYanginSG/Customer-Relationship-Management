import { LoginForm } from "@/components/LoginForm";

const ERRORS: Record<string, string> = {
  missing_code: "That link was incomplete. Please request a new one.",
  exchange_failed: "That link has expired or was already used. Request a new one.",
  not_allowed:
    "That email address is not permitted to use this portal. Check ADMIN_ALLOWED_EMAILS in your Vercel settings.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const params = await searchParams;
  const message = params.error ? ERRORS[params.error] ?? "Something went wrong." : null;

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-xl font-semibold tracking-tight">Practice Manager</h1>
          <p className="mt-1.5 text-sm text-ink-soft">
            Enter your email and we&apos;ll send you a sign-in link.
          </p>
        </div>

        {message && (
          <div className="mb-4 rounded-md border border-alert/20 bg-alert/5 px-3.5 py-3 text-sm text-alert">
            {message}
          </div>
        )}

        <div className="card p-6">
          <LoginForm next={params.next ?? "/"} />
        </div>

        <p className="mt-6 text-center text-xs text-ink-faint">
          Only pre-approved addresses can sign in. There is no password to lose.
        </p>
      </div>
    </main>
  );
}
