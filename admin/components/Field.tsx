/** Small presentational building blocks shared by every form. */

export function Field({
  label, name, type = "text", defaultValue, placeholder, required, hint, className,
}: {
  label: string;
  name: string;
  type?: string;
  defaultValue?: string | number | null;
  placeholder?: string;
  required?: boolean;
  hint?: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <label htmlFor={name} className="label">
        {label}
        {required && <span className="text-alert ml-0.5">*</span>}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        required={required}
        placeholder={placeholder}
        defaultValue={defaultValue ?? undefined}
        className="input"
      />
      {hint && <p className="mt-1 text-xs text-ink-faint">{hint}</p>}
    </div>
  );
}

export function Select({
  label, name, options, defaultValue, includeBlank, hint, className,
}: {
  label: string;
  name: string;
  options: Array<{ value: string; label: string }>;
  defaultValue?: string | null;
  includeBlank?: string;
  hint?: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <label htmlFor={name} className="label">{label}</label>
      <select id={name} name={name} defaultValue={defaultValue ?? ""} className="input">
        {includeBlank && <option value="">{includeBlank}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {hint && <p className="mt-1 text-xs text-ink-faint">{hint}</p>}
    </div>
  );
}

export function TextArea({
  label, name, defaultValue, placeholder, rows = 3, hint, required, className,
}: {
  label: string;
  name: string;
  defaultValue?: string | null;
  placeholder?: string;
  rows?: number;
  hint?: string;
  required?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <label htmlFor={name} className="label">
        {label}
        {required && <span className="text-alert ml-0.5">*</span>}
      </label>
      <textarea
        id={name}
        name={name}
        rows={rows}
        required={required}
        placeholder={placeholder}
        defaultValue={defaultValue ?? undefined}
        className="input resize-y"
      />
      {hint && <p className="mt-1 text-xs text-ink-faint">{hint}</p>}
    </div>
  );
}

export function Checkbox({
  label, name, defaultChecked, hint, onChange,
}: {
  label: string;
  name: string;
  defaultChecked?: boolean;
  hint?: string;
  onChange?: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-2.5 pt-5">
      <input
        id={name}
        name={name}
        type="checkbox"
        defaultChecked={defaultChecked}
        onChange={(e) => onChange?.(e.target.checked)}
        className="mt-0.5 h-4 w-4 rounded border-line text-ink focus:ring-calm/30"
      />
      <div>
        <label htmlFor={name} className="text-sm text-ink">{label}</label>
        {hint && <p className="text-xs text-ink-faint">{hint}</p>}
      </div>
    </div>
  );
}

export function FormMessage({
  result,
}: {
  result: { ok: boolean; error?: string; message?: string } | null;
}) {
  if (!result) return null;
  if (result.ok && result.message) {
    return (
      <p className="text-sm text-good" role="status">{result.message}</p>
    );
  }
  if (!result.ok && result.error) {
    return (
      <p className="text-sm text-alert" role="alert">{result.error}</p>
    );
  }
  return null;
}
