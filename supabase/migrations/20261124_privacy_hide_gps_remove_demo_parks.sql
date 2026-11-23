-- TripleStack privacy fix: GPS coordinates are admin-only.
-- Also deactivate the three demo parks; residents continue entering park names manually.
begin;

update public.parks
set active = false
where lower(btrim(name)) in ('central playground', 'greenfield park', 'riverside park');

-- Recreate the public projection without latitude/longitude. The base complaints
-- table remains available only to approved admins through its existing RLS policy.
drop view if exists public.public_complaints;

create view public.public_complaints
with (security_barrier = true)
as
select
  c.id,
  c.park_id,
  c.park_name,
  c.category,
  c.title,
  c.location,
  c.description,
  c.photo_path,
  c.status,
  c.resolution_notes,
  c.resolution_photo_path,
  c.created_at,
  c.resolved_at,
  exists (
    select 1
    from public.feedback f
    where f.complaint_id = c.id
  ) as has_feedback
from public.complaints c;

revoke all on public.public_complaints from public;
grant select on public.public_complaints to anon, authenticated;

commit;
