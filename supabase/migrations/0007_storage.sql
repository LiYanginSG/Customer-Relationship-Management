-- ============================================================================
-- 0007_storage.sql
-- A private bucket for product summaries, brochures and policy contracts.
-- Private means: no public URL, no link that can be forwarded, readable only
-- with the service_role key from inside an edge function.
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'products',
  'products',
  false,
  52428800,  -- 50 MB, comfortably above a long policy contract
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
    'text/markdown'
  ]
)
on conflict (id) do nothing;

-- A second private bucket for spreadsheet imports, kept so that a failed
-- import can be re-examined rather than guessed at.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'imports',
  'imports',
  false,
  20971520,  -- 20 MB
  array[
    'text/csv',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/octet-stream'
  ]
)
on conflict (id) do nothing;
