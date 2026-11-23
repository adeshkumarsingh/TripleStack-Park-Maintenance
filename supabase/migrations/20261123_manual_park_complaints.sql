-- TripleStack: allow residents to type a park name and attach GPS coordinates.
-- Safe migration: preserves existing complaint rows and park records.
begin;

alter table public.complaints
  add column if not exists park_name text;

update public.complaints c
set park_name = p.name
from public.parks p
where c.park_id = p.id
  and c.park_name is null;

-- Existing rows are backfilled from their linked park before park_id becomes optional.
alter table public.complaints
  alter column park_id drop not null;

alter table public.complaints
  alter column park_name set not null;

-- New RPC signature accepts a typed park name. If it matches an active park,
-- retain that park's ID; otherwise park_id remains NULL and park_name is saved.
create or replace function public.submit_public_complaint(
  p_reporter_key uuid,
  p_feedback_token text,
  p_park_id uuid,
  p_park_name text,
  p_category text,
  p_location text,
  p_description text,
  p_latitude double precision default null,
  p_longitude double precision default null,
  p_photo_path text default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, auth, storage, pg_temp
as $$
declare
  v_reporter_hash text;
  v_feedback_hash text;
  v_park_name text;
  v_park_id uuid;
  v_complaint_id uuid;
  v_recent integer;
begin
  if p_reporter_key is null or p_feedback_token is null or length(p_feedback_token) < 24 then
    raise exception 'A valid submission token is required.' using errcode = '22023';
  end if;
  if p_category not in (
    'Lighting', 'Playground equipment', 'Waste and cleanliness',
    'Pathway or pavement', 'Water / drainage', 'Plants and trees', 'Other'
  ) then
    raise exception 'Please select a valid issue category.' using errcode = '22023';
  end if;
  if p_park_name is null or length(btrim(p_park_name)) < 2 or length(p_park_name) > 120 then
    raise exception 'Enter a park name between 2 and 120 characters.' using errcode = '22023';
  end if;
  if p_location is not null and length(p_location) > 140 then
    raise exception 'Location details must be 140 characters or fewer.' using errcode = '22023';
  end if;
  if p_description is null or length(btrim(p_description)) < 5 or length(p_description) > 1200 then
    raise exception 'Describe the issue using 5 to 1,200 characters.' using errcode = '22023';
  end if;
  if (p_latitude is null) <> (p_longitude is null)
     or (p_latitude is not null and (p_latitude < -90 or p_latitude > 90))
     or (p_longitude is not null and (p_longitude < -180 or p_longitude > 180)) then
    raise exception 'The supplied coordinates are invalid.' using errcode = '22023';
  end if;

  select p.id, p.name into v_park_id, v_park_name
  from public.parks p
  where p.active = true and lower(p.name) = lower(btrim(p_park_name))
  limit 1;

  -- Preserve the typed name when it is not in the managed parks list.
  v_park_name := coalesce(v_park_name, btrim(p_park_name));

  v_reporter_hash := encode(digest(convert_to(p_reporter_key::text, 'UTF8'), 'sha256'), 'hex');
  v_feedback_hash := encode(digest(convert_to(p_feedback_token, 'UTF8'), 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(v_reporter_hash, 0));
  delete from public.submission_rate_events
  where created_at < now() - interval '1 day';

  select count(*) into v_recent
  from public.submission_rate_events e
  where e.reporter_key_hash = v_reporter_hash
    and e.created_at > now() - interval '1 hour';
  if v_recent >= 3 then
    raise exception 'Too many reports from this browser. Please try again later.' using errcode = 'P0001';
  end if;

  if p_photo_path is not null then
    if not exists (
      select 1 from public.photo_upload_intents i
      join storage.objects o on o.name = i.object_path and o.bucket_id = 'issue-photos'
      where i.object_path = p_photo_path
        and i.reporter_key_hash = v_reporter_hash
        and i.consumed_at is null
        and i.expires_at > now()
    ) then
      raise exception 'The uploaded photo is not valid or has expired. Please upload it again.' using errcode = '22023';
    end if;
  end if;

  insert into public.complaints(
    park_id, park_name, category, title, location, description,
    photo_path, latitude, longitude, status, feedback_token_hash
  ) values (
    v_park_id, v_park_name, p_category, p_category || ' at ' || v_park_name,
    coalesce(nullif(btrim(p_location), ''), case when p_latitude is not null then 'GPS location' else 'Not specified' end),
    btrim(p_description), p_photo_path, p_latitude, p_longitude, 'submitted', v_feedback_hash
  ) returning id into v_complaint_id;

  if p_photo_path is not null then
    update public.photo_upload_intents
    set consumed_at = now()
    where object_path = p_photo_path and reporter_key_hash = v_reporter_hash;
  end if;

  insert into public.submission_rate_events(reporter_key_hash) values (v_reporter_hash);
  return v_complaint_id;
end;
$$;

-- Remove the previous overload so PostgREST sees one unambiguous submission RPC.
drop function if exists public.submit_public_complaint(uuid, text, uuid, text, text, text, double precision, double precision, text);

revoke all on function public.submit_public_complaint(uuid, text, uuid, text, text, text, text, double precision, double precision, text) from public;
grant execute on function public.submit_public_complaint(uuid, text, uuid, text, text, text, text, double precision, double precision, text) to anon, authenticated;

create or replace view public.public_complaints
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
  case when c.latitude is null then null else round(c.latitude::numeric, 3)::double precision end as latitude,
  case when c.longitude is null then null else round(c.longitude::numeric, 3)::double precision end as longitude,
  c.created_at,
  c.resolved_at,
  exists(select 1 from public.feedback f where f.complaint_id = c.id) as has_feedback
from public.complaints c;

revoke all on public.public_complaints from public;
grant select on public.public_complaints to anon, authenticated;

commit;
