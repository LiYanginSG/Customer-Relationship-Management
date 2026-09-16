-- ============================================================================
-- 0009_search_fallback.sql
-- Makes product search forgiving enough to be useful.
--
-- The problem this fixes: Postgres stems "excluded" to "exclud" and
-- "exclusion" to "exclus". They are different lexemes, so a search for
-- "pre-existing exclusion" fails to match a clause that says "pre-existing
-- conditions are excluded" -- even though that is exactly the passage wanted.
-- Combined with websearch_to_tsquery's AND-by-default, a perfectly reasonable
-- question returns nothing.
--
-- The fix: try the precise AND search first, and only if it finds nothing,
-- fall back to matching any of the terms. Precision when it is available,
-- recall when it is not.
-- ============================================================================

-- The return type gains a match_type column, and Postgres will not alter the
-- signature of an existing function in place.
drop function if exists search_products(text, text, integer);

create function search_products(
  query_text     text,
  insurer_filter text default null,
  max_results    integer default 8
)
returns table (
  chunk_id     uuid,
  product_id   uuid,
  insurer      text,
  product_name text,
  doc_type     text,
  heading      text,
  content      text,
  page_from    integer,
  rank         real,
  match_type   text
)
language plpgsql stable as $$
declare
  strict_query  tsquery;
  loose_query   tsquery;
  hits          integer;
  lexemes       text[];
  limit_to      integer := greatest(1, least(coalesce(max_results, 8), 25));
begin
  if query_text is null or btrim(query_text) = '' then
    return;
  end if;

  strict_query := websearch_to_tsquery('english', query_text);

  select count(*) into hits
    from product_chunks pc
    join products p on p.id = pc.product_id
   where pc.search_vector @@ strict_query
     and p.status = 'current'
     and (insurer_filter is null or p.insurer ilike insurer_filter);

  if hits > 0 then
    return query
      select pc.id, p.id, p.insurer, p.name, p.doc_type, pc.heading, pc.content,
             pc.page_from,
             ts_rank(pc.search_vector, strict_query) as rank,
             'exact'::text
        from product_chunks pc
        join products p on p.id = pc.product_id
       where pc.search_vector @@ strict_query
         and p.status = 'current'
         and (insurer_filter is null or p.insurer ilike insurer_filter)
       order by rank desc
       limit limit_to;
    return;
  end if;

  -- Nothing matched all the terms. Try any of them.
  lexemes := tsvector_to_array(to_tsvector('english', query_text));

  -- A query made entirely of stop words ("what is the") leaves no lexemes, and
  -- to_tsquery('') raises. Returning empty is the honest answer.
  if lexemes is null or array_length(lexemes, 1) is null then
    return;
  end if;

  loose_query := to_tsquery('english', array_to_string(lexemes, ' | '));

  return query
    select pc.id, p.id, p.insurer, p.name, p.doc_type, pc.heading, pc.content,
           pc.page_from,
           ts_rank(pc.search_vector, loose_query) as rank,
           'partial'::text
      from product_chunks pc
      join products p on p.id = pc.product_id
     where pc.search_vector @@ loose_query
       and p.status = 'current'
       and (insurer_filter is null or p.insurer ilike insurer_filter)
     order by rank desc
     limit limit_to;
end;
$$;

comment on function search_products is
  'Product document search. Tries an all-terms match first, then falls back to any-term. match_type tells the caller which one produced the result, so a partial match can be reported as such rather than quoted as definitive.';
