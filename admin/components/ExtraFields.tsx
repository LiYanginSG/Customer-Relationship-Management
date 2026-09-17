/**
 * Columns an import brought in that have no field of their own.
 *
 * Showing them matters. Data kept but never displayed is indistinguishable
 * from data thrown away -- the adviser would have no idea their surrender
 * values had survived the import.
 */
export function ExtraFields({
  title, extra, note,
}: {
  title: string;
  extra: Record<string, unknown> | null | undefined;
  note?: string;
}) {
  if (!extra || Object.keys(extra).length === 0) return null;

  const entries = Object.entries(extra).filter(
    ([, v]) => v !== null && v !== undefined && v !== "",
  );
  if (entries.length === 0) return null;

  return (
    <section>
      <h2 className="text-sm font-semibold mb-3">{title}</h2>
      <dl className="card p-4 space-y-2.5 text-sm">
        {entries.map(([key, value]) => (
          <div key={key} className="flex justify-between gap-3">
            <dt className="text-ink-soft shrink-0">{key}</dt>
            <dd className="text-right min-w-0 break-words">
              {typeof value === "object"
                ? JSON.stringify(value)
                : String(value)}
            </dd>
          </div>
        ))}
      </dl>
      {note && <p className="mt-2 text-xs text-ink-faint">{note}</p>}
    </section>
  );
}
