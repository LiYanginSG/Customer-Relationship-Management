import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { Shell } from "@/components/Shell";
import { ClientForm } from "@/components/ClientForm";

export const dynamic = "force-dynamic";

export default async function NewClientPage() {
  const user = await requireUser();

  return (
    <Shell email={user.email}>
      <div className="mb-5">
        <Link href="/clients" className="text-sm text-ink-soft hover:text-ink">
          ← Clients
        </Link>
        <h1 className="mt-1.5 text-lg font-semibold tracking-tight">Add a client</h1>
      </div>
      <div className="max-w-3xl">
        <ClientForm />
      </div>
    </Shell>
  );
}
