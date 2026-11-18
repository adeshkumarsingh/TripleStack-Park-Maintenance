-- TripleStack Park Maintenance Tracker — hardened schema
-- Run the full script in Supabase Dashboard > SQL Editor.
-- This is an additive migration for the supplied starter project. Review before using on live data.

create schema if not exists extensions;
revoke create on schema extensions from public, anon, authenticated;
create extension if not exists pgcrypto with schema extensions;
-- Older installations may already have pgcrypto in public. Keep either location
-- supported, and remove client CREATE rights so the fixed function search path is safe.
revoke create on schema public from public, anon, authenticated;

create schema if not exists triplestack_private;
revoke all on schema triplestack_private from public, anon, authenticated;
grant usage on schema triplestack_private to anon, authenticated;

-- -----------------------------------------------------------------------------
-- Core tables
-- -----------------------------------------------------------------------------
create table if not exists public.parks (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.complaints (
  id uuid primary key default gen_random_uuid(),
  park_id uuid not null references public.parks(id),
  category text not null,
  title text not null,
  location text not null,
  description text not null,
  -- New installs store private-bucket object paths in these columns.
  photo_path text,
  resolution_photo_path text,
  -- Legacy URL columns are retained so existing installations migrate without data loss.
  photo_url text,
  resolution_photo_url text,
  latitude double precision,
  longitude double precision,
  status text not null default 'submitted'
    check (status in ('submitted','assigned','in_progress','resolved')),
  assigned_staff text,
  resolution_notes text,
  feedback_token_hash text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

alter table public.complaints add column if not exists latitude double precision;
alter table public.complaints add column if not exists longitude double precision;
alter table public.complaints add column if not exists photo_path text;
alter table public.complaints add column if not exists resolution_photo_path text;
alter table public.complaints add column if not exists feedback_token_hash text;

-- Migrate object paths from the old public URLs where possible. Existing generated names
-- were simple timestamp/UUID filenames, so the URL suffix is a safe storage object path.
update public.complaints
set photo_path = split_part(regexp_replace(photo_url, '^.*?/object/public/issue-photos/', ''), '?', 1)
where photo_path is null
  and photo_url like '%/object/public/issue-photos/%';

update public.complaints
set resolution_photo_path = split_part(regexp_replace(resolution_photo_url, '^.*?/object/public/issue-photos/', ''), '?', 1)
where resolution_photo_path is null
  and resolution_photo_url like '%/object/public/issue-photos/%';

-- Retain the starter's valid coordinate invariant, with a stable constraint name.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'complaints_valid_coordinates'
      and conrelid = 'public.complaints'::regclass
  ) then
    alter table public.complaints
      add constraint complaints_valid_coordinates check (
        (latitude is null and longitude is null)
        or (latitude is not null and longitude is not null
            and latitude between -90 and 90 and longitude between -180 and 180)
      );
  end if;
end $$;

create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  complaint_id uuid not null unique references public.complaints(id) on delete cascade,
  rating int not null check (rating between 1 and 5),
  comment text,
  created_at timestamptz not null default now()
);


-- General visitor feedback is separate from resolution feedback tied to a report.
create table if not exists public.site_feedback (
  id uuid primary key default gen_random_uuid(),
  topic text not null check (length(topic) between 1 and 60),
  rating integer not null check (rating between 1 and 5),
  comment text not null check (length(btrim(comment)) between 1 and 600),
  reporter_key_hash text not null,
  created_at timestamptz not null default now()
);
create index if not exists site_feedback_created_at_idx on public.site_feedback(created_at desc);
create table if not exists public.site_feedback_rate_events (
  id bigint generated always as identity primary key,
  reporter_key_hash text not null,
  created_at timestamptz not null default now()
);
create index if not exists site_feedback_rate_events_key_time_idx on public.site_feedback_rate_events(reporter_key_hash, created_at desc);

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Best-effort anonymous-browser rate limiting. The client identifier is hashed and is
-- not a security identity; resettable browser storage means a determined attacker can
-- rotate it. Use an IP-aware Edge Function + CAPTCHA for high-risk public deployments.
create table if not exists public.submission_rate_events (
  id bigint generated always as identity primary key,
  reporter_key_hash text not null,
  created_at timestamptz not null default now()
);
create index if not exists submission_rate_events_key_time_idx
  on public.submission_rate_events (reporter_key_hash, created_at desc);
create index if not exists submission_rate_events_created_at_idx
  on public.submission_rate_events (created_at);

create table if not exists public.photo_upload_intents (
  object_path text primary key,
  reporter_key_hash text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  consumed_at timestamptz
);
create index if not exists photo_upload_intents_key_time_idx
  on public.photo_upload_intents (reporter_key_hash, created_at desc);
create index if not exists photo_upload_intents_expiry_idx
  on public.photo_upload_intents (expires_at);

create table if not exists public.photo_upload_rate_events (
  id bigint generated always as identity primary key,
  reporter_key_hash text not null,
  created_at timestamptz not null default now()
);
create index if not exists photo_upload_rate_events_key_time_idx
  on public.photo_upload_rate_events (reporter_key_hash, created_at desc);
create index if not exists photo_upload_rate_events_created_at_idx
  on public.photo_upload_rate_events (created_at);

create index if not exists complaints_created_at_idx
  on public.complaints (created_at desc);

-- Admin-only audit trail for staff changes.
create table if not exists public.complaint_activity (
  id bigint generated always as identity primary key,
  complaint_id uuid not null references public.complaints(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  old_status text,
  new_status text,
  changes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists complaint_activity_complaint_time_idx
  on public.complaint_activity (complaint_id, created_at desc);

insert into public.parks(name,description) values
 ('Riverside Park','Along the river path'),
 ('Greenfield Park','Under the tree canopy'),
 ('Central Playground','Open lawn and play area')
on conflict (name) do nothing;

-- -----------------------------------------------------------------------------
-- RLS and hardened helper functions
-- -----------------------------------------------------------------------------
alter table public.parks enable row level security;
alter table public.complaints enable row level security;
alter table public.feedback enable row level security;
alter table public.site_feedback enable row level security;
alter table public.site_feedback_rate_events enable row level security;
alter table public.admin_users enable row level security;
alter table public.submission_rate_events enable row level security;
alter table public.photo_upload_intents enable row level security;
alter table public.photo_upload_rate_events enable row level security;
alter table public.complaint_activity enable row level security;

create or replace function public.is_park_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, extensions, auth, pg_temp
as $$
  select exists (
    select 1 from public.admin_users au
    where au.user_id = auth.uid()
  );
$$;

revoke all on function public.is_park_admin() from public;
grant execute on function public.is_park_admin() to anon, authenticated;

-- Upload intents bind a one-time object path to the browser's random reporter key.
create or replace function public.create_photo_upload_intent(
  p_reporter_key uuid,
  p_extension text
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, auth, storage, pg_temp
as $$
declare
  v_reporter_hash text;
  v_path text;
  v_recent integer;
begin
  if p_reporter_key is null then
    raise exception 'A valid reporter key is required.' using errcode = '22023';
  end if;
  if p_extension is null or p_extension not in ('jpg', 'png', 'webp') then
    raise exception 'Unsupported image type.' using errcode = '22023';
  end if;

  v_reporter_hash := encode(digest(convert_to(p_reporter_key::text, 'UTF8'), 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(v_reporter_hash, 0));

  delete from public.photo_upload_intents
  where expires_at < now() - interval '1 day';
  delete from public.photo_upload_rate_events
  where created_at < now() - interval '1 day';

  select count(*) into v_recent
  from public.photo_upload_rate_events
  where reporter_key_hash = v_reporter_hash
    and created_at > now() - interval '1 hour';

  if v_recent >= 5 then
    raise exception 'Too many photo upload attempts. Please try again later.' using errcode = 'P0001';
  end if;

  insert into public.photo_upload_rate_events(reporter_key_hash) values (v_reporter_hash);
  -- Use an opaque per-upload path; do not expose a stable reporter hash in public image URLs.
  v_path := 'report-photos/' || gen_random_uuid()::text || '.' || p_extension;
  insert into public.photo_upload_intents(object_path, reporter_key_hash)
  values (v_path, v_reporter_hash);
  return v_path;
end;
$$;

create or replace function public.cancel_photo_upload_intent(
  p_reporter_key uuid,
  p_object_path text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_reporter_hash text;
begin
  if p_reporter_key is null or p_object_path is null then
    return;
  end if;
  v_reporter_hash := encode(digest(convert_to(p_reporter_key::text, 'UTF8'), 'sha256'), 'hex');
  delete from public.photo_upload_intents
  where object_path = p_object_path
    and reporter_key_hash = v_reporter_hash
    and consumed_at is null;
end;
$$;

create or replace function triplestack_private.is_reserved_photo_upload(object_name text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
  select exists (
    select 1 from public.photo_upload_intents i
    where i.object_path = object_name
      and i.consumed_at is null
      and i.expires_at > now()
  );
$$;

create or replace function triplestack_private.is_linked_report_photo(object_name text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
  select exists (
    select 1 from public.complaints c
    where c.photo_path = object_name
       or c.resolution_photo_path = object_name
  );
$$;

revoke all on function public.create_photo_upload_intent(uuid, text) from public;
revoke all on function public.cancel_photo_upload_intent(uuid, text) from public;
revoke all on function triplestack_private.is_reserved_photo_upload(text) from public;
revoke all on function triplestack_private.is_linked_report_photo(text) from public;
grant execute on function public.create_photo_upload_intent(uuid, text) to anon, authenticated;
grant execute on function public.cancel_photo_upload_intent(uuid, text) to anon, authenticated;
grant execute on function triplestack_private.is_reserved_photo_upload(text) to anon, authenticated;
grant execute on function triplestack_private.is_linked_report_photo(text) to anon, authenticated;

-- Public complaint submission is an RPC so browser clients cannot write arbitrary
-- columns such as staff assignment, resolution details, status or feedback token hash.
create or replace function public.submit_public_complaint(
  p_reporter_key uuid,
  p_feedback_token text,
  p_park_id uuid,
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
  if p_location is null or length(btrim(p_location)) < 2 or length(p_location) > 140 then
    raise exception 'Enter a park location between 2 and 140 characters.' using errcode = '22023';
  end if;
  if p_description is null or length(btrim(p_description)) < 5 or length(p_description) > 1200 then
    raise exception 'Describe the issue using 5 to 1,200 characters.' using errcode = '22023';
  end if;
  if (p_latitude is null) <> (p_longitude is null)
     or (p_latitude is not null and (p_latitude < -90 or p_latitude > 90))
     or (p_longitude is not null and (p_longitude < -180 or p_longitude > 180)) then
    raise exception 'The supplied coordinates are invalid.' using errcode = '22023';
  end if;

  select p.name into v_park_name
  from public.parks p
  where p.id = p_park_id and p.active = true;
  if v_park_name is null then
    raise exception 'The selected park is unavailable.' using errcode = '22023';
  end if;

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
    park_id, category, title, location, description,
    photo_path, latitude, longitude, status, feedback_token_hash
  ) values (
    p_park_id, p_category, p_category || ' at ' || v_park_name,
    btrim(p_location), btrim(p_description), p_photo_path,
    p_latitude, p_longitude, 'submitted', v_feedback_hash
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

-- The feedback token is generated in the reporting browser and stored only as a hash.
-- No public SELECT/INSERT policy exists on the feedback table.
create or replace function public.submit_feedback(
  p_complaint_id uuid,
  p_feedback_token text,
  p_rating integer,
  p_comment text default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, auth, pg_temp
as $$
declare
  v_expected_hash text;
  v_actual_hash text;
begin
  if p_feedback_token is null or length(p_feedback_token) < 24 then
    raise exception 'The feedback access token is missing. Use the browser that submitted the report.' using errcode = '22023';
  end if;
  if p_rating is null or p_rating < 1 or p_rating > 5 then
    raise exception 'Select a rating from 1 to 5.' using errcode = '22023';
  end if;
  if p_comment is not null and length(p_comment) > 600 then
    raise exception 'Feedback must be 600 characters or fewer.' using errcode = '22023';
  end if;

  select c.feedback_token_hash into v_expected_hash
  from public.complaints c
  where c.id = p_complaint_id and c.status = 'resolved';
  if v_expected_hash is null then
    raise exception 'This request is not ready for feedback or the access token is invalid.' using errcode = 'P0001';
  end if;

  v_actual_hash := encode(digest(convert_to(p_feedback_token, 'UTF8'), 'sha256'), 'hex');
  if v_actual_hash <> v_expected_hash then
    raise exception 'Only the person who submitted this report can leave feedback.' using errcode = '42501';
  end if;

  insert into public.feedback(complaint_id, rating, comment)
  values (p_complaint_id, p_rating, nullif(btrim(p_comment), ''));
  update public.complaints
  set feedback_token_hash = null
  where id = p_complaint_id;
exception
  when unique_violation then
    raise exception 'Feedback has already been submitted for this request.' using errcode = '23505';
end;
$$;

revoke all on function public.submit_public_complaint(uuid, text, uuid, text, text, text, double precision, double precision, text) from public;
revoke all on function public.submit_feedback(uuid, text, integer, text) from public;
grant execute on function public.submit_public_complaint(uuid, text, uuid, text, text, text, double precision, double precision, text) to anon, authenticated;
grant execute on function public.submit_feedback(uuid, text, integer, text) to anon, authenticated;


-- Public website feedback: anonymous inserts are validated and throttled server-side.
create or replace function public.submit_site_feedback(
  p_reporter_key uuid,
  p_topic text,
  p_rating integer,
  p_comment text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, auth, pg_temp
as $$
declare
  v_key_hash text;
  v_recent integer;
begin
  if p_reporter_key is null then raise exception 'Feedback session is invalid. Refresh and try again.' using errcode = '22023'; end if;
  if p_topic is null or length(btrim(p_topic)) not between 1 and 60 then raise exception 'Select a valid feedback topic.' using errcode = '22023'; end if;
  if p_rating is null or p_rating < 1 or p_rating > 5 then raise exception 'Select a rating from 1 to 5.' using errcode = '22023'; end if;
  if p_comment is null or length(btrim(p_comment)) not between 1 and 600 then raise exception 'Feedback must be between 1 and 600 characters.' using errcode = '22023'; end if;
  v_key_hash := encode(digest(convert_to(p_reporter_key::text, 'UTF8'), 'sha256'), 'hex');
  select count(*) into v_recent from public.site_feedback_rate_events
    where reporter_key_hash = v_key_hash and created_at > now() - interval '1 hour';
  if v_recent >= 3 then raise exception 'Feedback limit reached. Please try again later.' using errcode = '42900'; end if;
  insert into public.site_feedback(topic, rating, comment, reporter_key_hash)
    values (btrim(p_topic), p_rating, btrim(p_comment), v_key_hash);
  insert into public.site_feedback_rate_events(reporter_key_hash) values (v_key_hash);
end;
$$;
revoke all on function public.submit_site_feedback(uuid, text, integer, text) from public;
grant execute on function public.submit_site_feedback(uuid, text, integer, text) to anon, authenticated;

-- Admin-only activity log. Trigger records state changes without relying on client code.
create or replace function public.log_complaint_admin_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, auth, pg_temp
as $$
declare
  v_changes jsonb := '{}'::jsonb;
begin
  if old.status is distinct from new.status then
    v_changes := v_changes || jsonb_build_object('status', jsonb_build_object('from', old.status, 'to', new.status));
  end if;
  if old.assigned_staff is distinct from new.assigned_staff then
    v_changes := v_changes || jsonb_build_object('assigned_staff', jsonb_build_object('from', old.assigned_staff, 'to', new.assigned_staff));
  end if;
  if old.resolution_notes is distinct from new.resolution_notes then
    v_changes := v_changes || jsonb_build_object('resolution_notes', 'updated');
  end if;
  if old.resolution_photo_path is distinct from new.resolution_photo_path then
    v_changes := v_changes || jsonb_build_object('resolution_photo', 'updated');
  end if;

  if v_changes <> '{}'::jsonb then
    insert into public.complaint_activity(
      complaint_id, actor_user_id, old_status, new_status, changes
    ) values (
      new.id, auth.uid(), old.status, new.status, v_changes
    );
  end if;
  return new;
end;
$$;

drop trigger if exists complaints_admin_change_log on public.complaints;
create trigger complaints_admin_change_log
after update on public.complaints
for each row execute function public.log_complaint_admin_change();

-- -----------------------------------------------------------------------------
-- RLS policies
-- -----------------------------------------------------------------------------
drop policy if exists "Parks are visible to everyone" on public.parks;
create policy "Parks are visible to everyone" on public.parks
  for select to anon, authenticated using (active = true);
drop policy if exists "Admins manage parks" on public.parks;
create policy "Admins manage parks" on public.parks
  for all to authenticated using (public.is_park_admin()) with check (public.is_park_admin());

-- Base complaint records are no longer publicly readable or directly insertable.
drop policy if exists "Anyone can view complaints" on public.complaints;
drop policy if exists "Anyone can submit complaints" on public.complaints;
drop policy if exists "Admins can view complaints" on public.complaints;
drop policy if exists "Admins update complaints" on public.complaints;
drop policy if exists "Admins delete complaints" on public.complaints;
create policy "Admins can view complaints" on public.complaints
  for select to authenticated using (public.is_park_admin());
create policy "Admins update complaints" on public.complaints
  for update to authenticated using (public.is_park_admin()) with check (public.is_park_admin());
create policy "Admins delete complaints" on public.complaints
  for delete to authenticated using (public.is_park_admin());

-- Feedback is writable only via the ownership-token RPC; feedback rows are admin-only.
drop policy if exists "Anyone can submit feedback" on public.feedback;
drop policy if exists "Anyone can check feedback submission" on public.feedback;
drop policy if exists "Admins manage feedback" on public.feedback;
drop policy if exists "Admins read site feedback" on public.site_feedback;
create policy "Admins read site feedback" on public.site_feedback for select to authenticated using (public.is_park_admin());
create policy "Admins manage feedback" on public.feedback
  for all to authenticated using (public.is_park_admin()) with check (public.is_park_admin());

-- Admin allow-list, rate-limit state, upload intents and activity records are private.
drop policy if exists "Admins manage admin list" on public.admin_users;
drop policy if exists "Admins read complaint activity" on public.complaint_activity;
create policy "Admins read complaint activity" on public.complaint_activity
  for select to authenticated using (public.is_park_admin());

-- -----------------------------------------------------------------------------
-- Public projection: deliberately excludes assigned staff, exact GPS, feedback token
-- hashes, reporter identifiers and internal table columns. Coordinates are rounded to
-- 3 decimal places (roughly 100 m) before reaching public browsers.
-- This view intentionally runs with its owner's table permissions; never add secrets here.
-- -----------------------------------------------------------------------------
drop function if exists public.get_feedback_complaint_ids();

create or replace view public.public_complaints
with (security_barrier = true)
as
select
  c.id,
  c.park_id,
  p.name as park_name,
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
from public.complaints c
join public.parks p on p.id = c.park_id;

revoke all on public.public_complaints from public;
grant select on public.public_complaints to anon, authenticated;

-- Least-privilege Data API grants. RLS remains the authorization boundary.
grant usage on schema public to anon, authenticated;
revoke all on public.parks from anon, authenticated;
grant select on public.parks to anon, authenticated;
grant insert, update, delete on public.parks to authenticated;

revoke all on public.complaints from anon, authenticated;
grant select, update, delete on public.complaints to authenticated;

revoke all on public.feedback from anon, authenticated;
revoke all on public.site_feedback from anon, authenticated;
revoke all on public.site_feedback_rate_events from anon, authenticated;
grant select on public.site_feedback to authenticated;
grant select, insert, update, delete on public.feedback to authenticated;

revoke all on public.admin_users from anon, authenticated;
revoke all on public.submission_rate_events from anon, authenticated;
revoke all on public.photo_upload_intents from anon, authenticated;
revoke all on public.photo_upload_rate_events from anon, authenticated;
revoke all on public.complaint_activity from anon, authenticated;
grant select on public.complaint_activity to authenticated;

-- -----------------------------------------------------------------------------
-- Private evidence storage with narrow upload/read/delete permissions.
-- Existing public URLs are migrated to paths above; making this bucket private means
-- the site must create short-lived signed URLs to display linked evidence.
-- -----------------------------------------------------------------------------
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('issue-photos', 'issue-photos', false, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set
  public = false,
  file_size_limit = 5242880,
  allowed_mime_types = array['image/jpeg','image/png','image/webp'];

drop policy if exists "Anyone can upload issue photos" on storage.objects;
drop policy if exists "Public can view issue photos" on storage.objects;
drop policy if exists "Admins can delete issue photos" on storage.objects;
drop policy if exists "Only reserved uploads or admins can upload issue photos" on storage.objects;
drop policy if exists "Only linked evidence or admins can read issue photos" on storage.objects;
drop policy if exists "Admins or unused reservations can delete issue photos" on storage.objects;

create policy "Only reserved uploads or admins can upload issue photos" on storage.objects
  for insert to anon, authenticated
  with check (
    bucket_id = 'issue-photos'
    and (public.is_park_admin() or triplestack_private.is_reserved_photo_upload(name))
  );

create policy "Only linked evidence or admins can read issue photos" on storage.objects
  for select to anon, authenticated
  using (
    bucket_id = 'issue-photos'
    and (public.is_park_admin() or triplestack_private.is_linked_report_photo(name))
  );

create policy "Admins or unused reservations can delete issue photos" on storage.objects
  for delete to anon, authenticated
  using (
    bucket_id = 'issue-photos'
    and (public.is_park_admin() or triplestack_private.is_reserved_photo_upload(name))
  );

-- Realtime is enabled for the admin workflow only. Public browsers read the safe view
-- and refresh periodically; they do not subscribe to raw complaint row changes.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'complaints'
     ) then
    alter publication supabase_realtime add table public.complaints;
  end if;
end $$;

-- After creating an admin account in Authentication > Users, copy its UUID and run:
-- insert into public.admin_users(user_id) values ('PASTE-ADMIN-USER-UUID-HERE');
