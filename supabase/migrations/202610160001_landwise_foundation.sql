-- Additive Landwise foundation. Apply only after reviewing the chosen Supabase
-- project. This migration does not configure OAuth or enable sponsored billing.
begin;

create schema landwise_private;
revoke all on schema landwise_private from public, anon, authenticated;

create table public.landwise_applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  job_key text not null check (job_key ~ '^[a-f0-9]{64}$'),
  company text not null default '' check (char_length(company) <= 160),
  role_title text not null check (char_length(role_title) between 1 and 160),
  stage text not null default 'resume' check (stage in ('resume', 'applied', 'interview', 'offer', 'closed')),
  notes text not null default '' check (char_length(notes) <= 12000),
  practice jsonb not null default '[]'::jsonb check (jsonb_typeof(practice) = 'array' and jsonb_array_length(practice) <= 100),
  history jsonb not null default '[]'::jsonb check (jsonb_typeof(history) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, job_key),
  unique (id, user_id)
);

create table public.landwise_application_versions (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null,
  user_id uuid not null,
  version_number integer not null check (version_number > 0),
  resume text not null check (char_length(btrim(resume)) > 0),
  job_description text not null check (char_length(btrim(job_description)) > 0),
  max_pages integer not null check (max_pages between 1 and 20),
  result jsonb not null check (jsonb_typeof(result) = 'object' and result ? 'transformedResume' and jsonb_typeof(result->'transformedResume') = 'string' and char_length(btrim(result->>'transformedResume')) > 0),
  created_at timestamptz not null default now(),
  foreign key (application_id, user_id) references public.landwise_applications(id, user_id) on delete cascade,
  unique (application_id, version_number)
);

create index landwise_applications_owner_updated_idx on public.landwise_applications(user_id, updated_at desc);
create index landwise_versions_owner_app_idx on public.landwise_application_versions(user_id, application_id, version_number);

alter table public.landwise_applications enable row level security;
alter table public.landwise_application_versions enable row level security;
create policy landwise_application_owner on public.landwise_applications
  for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy landwise_version_owner on public.landwise_application_versions
  for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- Clients may read only their RLS-scoped rows. Writes go through the bounded,
-- locking RPCs below, not unrestricted table updates or arbitrary user IDs.
revoke all on public.landwise_applications, public.landwise_application_versions from public, anon, authenticated;
grant select on public.landwise_applications, public.landwise_application_versions to authenticated;

create function landwise_private.landwise_application_summary(p_app public.landwise_applications)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', p_app.id, 'company', p_app.company, 'roleTitle', p_app.role_title,
    'stage', p_app.stage, 'createdAt', p_app.created_at, 'updatedAt', p_app.updated_at,
    'versionCount', (select count(*) from public.landwise_application_versions v where v.application_id = p_app.id and v.user_id = p_app.user_id),
    'score', (select v.result->'matchScore' from public.landwise_application_versions v where v.application_id = p_app.id and v.user_id = p_app.user_id order by v.version_number desc limit 1),
    'practiceDone', (select count(*) from jsonb_array_elements(p_app.practice) item where item->'done' = 'true'::jsonb),
    'practiceTotal', jsonb_array_length(p_app.practice)
  );
$$;

create function landwise_private.landwise_application_document(p_app public.landwise_applications)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', p_app.id, 'jobKey', p_app.job_key, 'company', p_app.company,
    'roleTitle', p_app.role_title, 'stage', p_app.stage, 'notes', p_app.notes,
    'practice', p_app.practice, 'history', p_app.history,
    'createdAt', p_app.created_at, 'updatedAt', p_app.updated_at,
    'versions', coalesce((select jsonb_agg(jsonb_build_object(
      'id', v.id, 'createdAt', v.created_at, 'resume', v.resume,
      'jobDescription', v.job_description, 'maxPages', v.max_pages, 'result', v.result
    ) order by v.version_number) from public.landwise_application_versions v
      where v.application_id = p_app.id and v.user_id = p_app.user_id), '[]'::jsonb)
  );
$$;

-- SECURITY DEFINER is limited to these explicit owner-scoped operations. The
-- empty search_path and fully qualified tables prevent object shadowing.
create function public.landwise_application_list()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'Sign in to access your applications.' using errcode = '42501'; end if;
  return jsonb_build_object('applications', coalesce((
    select jsonb_agg(landwise_private.landwise_application_summary(a) order by a.updated_at desc, a.id)
    from public.landwise_applications a where a.user_id = v_user
  ), '[]'::jsonb));
end;
$$;

create function public.landwise_application_get(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_app public.landwise_applications;
begin
  if v_user is null then raise exception 'Sign in to access your applications.' using errcode = '42501'; end if;
  select * into v_app from public.landwise_applications where id = p_id and user_id = v_user;
  if not found then raise exception 'This application no longer exists.' using errcode = 'P0002'; end if;
  return landwise_private.landwise_application_document(v_app);
end;
$$;

create function public.landwise_application_save(p_inputs jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid(); v_app public.landwise_applications;
  v_latest public.landwise_application_versions;
  v_now timestamptz := clock_timestamp(); v_key text; v_practice jsonb;
  v_resume text; v_jd text; v_result jsonb; v_pages integer; v_version uuid;
begin
  if v_user is null then raise exception 'Sign in to save your application.' using errcode = '42501'; end if;
  if jsonb_typeof(p_inputs) is distinct from 'object' or char_length(p_inputs::text) > 220000 then
    raise exception 'This application is invalid or too large to save.' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_object_keys(p_inputs) k where k not in ('resume', 'jobDescription', 'maxPages', 'result')) then
    raise exception 'Unsupported application input.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_inputs->'resume') is distinct from 'string'
    or jsonb_typeof(p_inputs->'jobDescription') is distinct from 'string'
    or jsonb_typeof(p_inputs->'result') is distinct from 'object'
    or jsonb_typeof(p_inputs#>'{result,transformedResume}') is distinct from 'string'
    or jsonb_typeof(p_inputs->'maxPages') is distinct from 'number' then
    raise exception 'A completed resume, job description and page limit are required.' using errcode = '22023';
  end if;
  v_resume := p_inputs->>'resume'; v_jd := p_inputs->>'jobDescription'; v_result := p_inputs->'result';
  if btrim(v_resume, E' \t\n\r\f') = '' or btrim(v_jd, E' \t\n\r\f') = '' or btrim(v_result->>'transformedResume', E' \t\n\r\f') = ''
    or (p_inputs->>'maxPages')::numeric <> trunc((p_inputs->>'maxPages')::numeric)
    or (p_inputs->>'maxPages')::numeric not between 1 and 20 then
    raise exception 'Check the resume, job description and page limit.' using errcode = '22023';
  end if;
  v_pages := (p_inputs->>'maxPages')::numeric::integer;
  -- A stable user lock also covers first-save/remove races where no application
  -- row exists yet. Other users remain independent.
  perform pg_advisory_xact_lock(hashtextextended('landwise_application:' || v_user::text, 0));
  v_now := clock_timestamp();
  v_key := encode(sha256(convert_to(btrim(v_jd, E' \t\n\r\f'), 'UTF8')), 'hex');
  select coalesce(jsonb_agg(jsonb_build_object('id', gen_random_uuid(),
    'title', left(coalesce(item->>'requirement', '') || ': ' || coalesce(item->>'nextStep', ''), 1000), 'done', false)), '[]'::jsonb)
    into v_practice from (
      select item from jsonb_array_elements(case when jsonb_typeof(v_result#>'{report,items}') = 'array' then v_result#>'{report,items}' else '[]'::jsonb end) item
      where coalesce(item->>'status', '') <> 'included' limit 30
    ) gaps;

  -- The unique key serializes simultaneous first saves; the row lock serializes
  -- subsequent save/update/remove operations before inspecting the latest draft.
  insert into public.landwise_applications (user_id, job_key, company, role_title, practice, history, created_at, updated_at)
    values (v_user, v_key, left(coalesce(v_result#>>'{job,company}', ''), 160),
      left(coalesce(nullif(v_result#>>'{job,roleTitle}', ''), 'Untitled role'), 160),
      v_practice, jsonb_build_array(jsonb_build_object('at', v_now, 'text', 'First resume prepared')), v_now, v_now)
    on conflict (user_id, job_key) do nothing;
  select * into v_app from public.landwise_applications where user_id = v_user and job_key = v_key for update;
  v_now := clock_timestamp();
  select * into v_latest from public.landwise_application_versions
    where application_id = v_app.id and user_id = v_user order by version_number desc limit 1;

  if found and v_latest.resume = v_resume and v_latest.result->>'transformedResume' = v_result->>'transformedResume'
    and (v_latest.result->'report') is not distinct from (v_result->'report') and v_latest.max_pages = v_pages then
    v_version := v_latest.id;
  else
    insert into public.landwise_application_versions (application_id, user_id, version_number, resume, job_description, max_pages, result, created_at)
      values (v_app.id, v_user, coalesce(v_latest.version_number, 0) + 1, v_resume, v_jd, v_pages, v_result, v_now)
      returning id into v_version;
  end if;
  update public.landwise_applications set updated_at = v_now where id = v_app.id and user_id = v_user returning * into v_app;
  return landwise_private.landwise_application_summary(v_app) || jsonb_build_object('versionId', v_version);
end;
$$;

create function public.landwise_application_update(p_id uuid, p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid(); v_app public.landwise_applications; v_now timestamptz := clock_timestamp();
  v_previous_stage text; v_previous_done integer; v_done integer; v_item jsonb;
begin
  if v_user is null then raise exception 'Sign in to update your application.' using errcode = '42501'; end if;
  if jsonb_typeof(p_patch) is distinct from 'object' or char_length(p_patch::text) > 220000 then raise exception 'Check your application changes.' using errcode = '22023'; end if;
  if exists (select 1 from jsonb_object_keys(p_patch) k where k not in ('company', 'roleTitle', 'stage', 'notes', 'practice')) then
    raise exception 'Unsupported application field.' using errcode = '22023';
  end if;
  if p_patch ? 'company' and (jsonb_typeof(p_patch->'company') <> 'string' or char_length(btrim(p_patch->>'company')) > 160)
    or p_patch ? 'roleTitle' and (jsonb_typeof(p_patch->'roleTitle') <> 'string' or char_length(btrim(p_patch->>'roleTitle')) not between 1 and 160)
    or p_patch ? 'stage' and (jsonb_typeof(p_patch->'stage') <> 'string' or p_patch->>'stage' not in ('resume', 'applied', 'interview', 'offer', 'closed'))
    or p_patch ? 'notes' and (jsonb_typeof(p_patch->'notes') <> 'string' or char_length(p_patch->>'notes') > 12000) then
    raise exception 'Check the company, role, progress and notes.' using errcode = '22023';
  end if;
  if p_patch ? 'practice' then
    if jsonb_typeof(p_patch->'practice') <> 'array' then raise exception 'Practice must be a task list.' using errcode = '22023'; end if;
    if jsonb_array_length(p_patch->'practice') > 100 then raise exception 'Too many practice tasks.' using errcode = '22023'; end if;
    for v_item in select value from jsonb_array_elements(p_patch->'practice') loop
      if jsonb_typeof(v_item) <> 'object' or jsonb_typeof(v_item->'id') is distinct from 'string'
        or char_length(v_item->>'id') > 100 or jsonb_typeof(v_item->'title') is distinct from 'string'
        or char_length(v_item->>'title') > 1000 or jsonb_typeof(v_item->'done') is distinct from 'boolean' then
        raise exception 'Check each practice task.' using errcode = '22023';
      end if;
      if exists (select 1 from jsonb_object_keys(v_item) k where k not in ('id', 'title', 'done')) then
        raise exception 'Unsupported practice task field.' using errcode = '22023';
      end if;
    end loop;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('landwise_application:' || v_user::text, 0));
  select * into v_app from public.landwise_applications where id = p_id and user_id = v_user for update;
  if not found then raise exception 'This application no longer exists.' using errcode = 'P0002'; end if;
  v_now := clock_timestamp();
  v_previous_stage := v_app.stage;
  select count(*) into v_previous_done from jsonb_array_elements(v_app.practice) item where item->'done' = 'true'::jsonb;
  if p_patch ? 'company' then v_app.company := btrim(p_patch->>'company'); end if;
  if p_patch ? 'roleTitle' then v_app.role_title := btrim(p_patch->>'roleTitle'); end if;
  if p_patch ? 'stage' then v_app.stage := p_patch->>'stage'; end if;
  if p_patch ? 'notes' then v_app.notes := p_patch->>'notes'; end if;
  if p_patch ? 'practice' then v_app.practice := p_patch->'practice'; end if;
  if v_app.stage <> v_previous_stage then
    v_app.history := v_app.history || jsonb_build_array(jsonb_build_object('at', v_now, 'text', 'Progress changed to ' || v_app.stage));
  end if;
  select count(*) into v_done from jsonb_array_elements(v_app.practice) item where item->'done' = 'true'::jsonb;
  if v_done <> v_previous_done then
    v_app.history := v_app.history || jsonb_build_array(jsonb_build_object('at', v_now, 'text', v_done || ' practice tasks completed'));
  end if;
  update public.landwise_applications set company = v_app.company, role_title = v_app.role_title,
    stage = v_app.stage, notes = v_app.notes, practice = v_app.practice, history = v_app.history, updated_at = v_now
    where id = p_id and user_id = v_user returning * into v_app;
  return landwise_private.landwise_application_document(v_app);
end;
$$;

create function public.landwise_application_remove(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'Sign in to remove your application.' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('landwise_application:' || v_user::text, 0));
  delete from public.landwise_applications where id = p_id and user_id = v_user;
  if not found then raise exception 'This application no longer exists.' using errcode = 'P0002'; end if;
  return jsonb_build_object('removed', true);
end;
$$;

-- One successful, saved sponsored Transform per stable verified auth user.
-- No client access, no grant/reset RPC, and no timeout reset that could race an
-- active paid request. A reserved request can only be explicitly released by
-- the server after it knows the attempt failed. OAuth/billing wiring is separate.
create table landwise_private.landwise_trial_ledger (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null check (status in ('reserved', 'used')),
  request_id uuid not null,
  reserved_at timestamptz not null,
  completed_at timestamptz,
  application_id uuid,
  version_id uuid,
  check ((status = 'reserved' and completed_at is null and application_id is null and version_id is null)
    or (status = 'used' and completed_at is not null and application_id is not null and version_id is not null))
  -- Application/version IDs intentionally have no FK: deleting a saved draft
  -- must not restore trial eligibility or erase the completed request receipt.
);
alter table landwise_private.landwise_trial_ledger enable row level security;
revoke all on landwise_private.landwise_trial_ledger from public, anon, authenticated, service_role;

create function landwise_private.landwise_trial_receipt(p_row landwise_private.landwise_trial_ledger)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_strip_nulls(jsonb_build_object('status', p_row.status, 'requestId', p_row.request_id,
    'reservedAt', p_row.reserved_at, 'completedAt', p_row.completed_at,
    'applicationId', p_row.application_id, 'versionId', p_row.version_id));
$$;

create function public.landwise_trial_reserve(p_user_id uuid, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row landwise_private.landwise_trial_ledger;
begin
  if p_user_id is null or p_request_id is null then raise exception 'A verified user and request are required.' using errcode = '22023'; end if;
  if not exists (select 1 from auth.users where id = p_user_id) then raise exception 'Verified user does not exist.' using errcode = '22023'; end if;
  -- Serialize even when there is no ledger row yet. The auth row also prevents
  -- reserve racing an explicit release between INSERT and SELECT FOR UPDATE.
  perform 1 from auth.users where id = p_user_id for update;
  insert into landwise_private.landwise_trial_ledger(user_id, status, request_id, reserved_at)
    values (p_user_id, 'reserved', p_request_id, clock_timestamp()) on conflict (user_id) do nothing;
  select * into v_row from landwise_private.landwise_trial_ledger where user_id = p_user_id for update;
  if v_row.request_id = p_request_id then return landwise_private.landwise_trial_receipt(v_row); end if;
  if v_row.status = 'used' then raise exception 'trial_already_used' using errcode = 'P0001'; end if;
  raise exception 'trial_request_in_progress' using errcode = 'P0001';
end;
$$;

create function public.landwise_trial_complete(p_user_id uuid, p_request_id uuid, p_application_id uuid, p_version_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row landwise_private.landwise_trial_ledger;
begin
  if p_user_id is null or p_request_id is null or p_application_id is null or p_version_id is null then
    raise exception 'The reservation and saved version are required.' using errcode = '22023';
  end if;
  perform 1 from auth.users where id = p_user_id for update;
  select * into v_row from landwise_private.landwise_trial_ledger where user_id = p_user_id for update;
  if not found or v_row.request_id <> p_request_id then raise exception 'trial_reservation_mismatch' using errcode = 'P0001'; end if;
  if v_row.status = 'used' then
    if v_row.application_id = p_application_id and v_row.version_id = p_version_id then return landwise_private.landwise_trial_receipt(v_row); end if;
    raise exception 'trial_already_used' using errcode = 'P0001';
  end if;
  -- Lock the owned saved version against concurrent deletion until the receipt
  -- commits. Never consume a trial for an unsaved or another user's result.
  perform 1 from public.landwise_application_versions where id = p_version_id and application_id = p_application_id and user_id = p_user_id for key share;
  if not found then raise exception 'The completed result must be saved in this user account.' using errcode = '22023'; end if;
  update landwise_private.landwise_trial_ledger set status = 'used', completed_at = clock_timestamp(),
    application_id = p_application_id, version_id = p_version_id where user_id = p_user_id returning * into v_row;
  return landwise_private.landwise_trial_receipt(v_row);
end;
$$;

create function public.landwise_trial_release(p_user_id uuid, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row landwise_private.landwise_trial_ledger;
begin
  if p_user_id is null or p_request_id is null then raise exception 'The reservation is required.' using errcode = '22023'; end if;
  perform 1 from auth.users where id = p_user_id for update;
  select * into v_row from landwise_private.landwise_trial_ledger where user_id = p_user_id for update;
  if not found then return jsonb_build_object('status', 'available', 'requestId', p_request_id); end if;
  if v_row.request_id <> p_request_id then raise exception 'trial_reservation_mismatch' using errcode = 'P0001'; end if;
  if v_row.status = 'used' then return landwise_private.landwise_trial_receipt(v_row); end if;
  delete from landwise_private.landwise_trial_ledger where user_id = p_user_id and request_id = p_request_id and status = 'reserved';
  return jsonb_build_object('status', 'available', 'requestId', p_request_id);
end;
$$;

-- Supabase may grant default function permissions to anon/authenticated. Reset
-- every new function explicitly, including private helpers, before allowing the
-- intended roles. No existing project tables or grants are changed.
revoke all on function landwise_private.landwise_application_summary(public.landwise_applications),
  landwise_private.landwise_application_document(public.landwise_applications),
  landwise_private.landwise_trial_receipt(landwise_private.landwise_trial_ledger)
  from public, anon, authenticated, service_role;
revoke all on function public.landwise_application_list(), public.landwise_application_get(uuid),
  public.landwise_application_save(jsonb), public.landwise_application_update(uuid, jsonb), public.landwise_application_remove(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.landwise_application_list(), public.landwise_application_get(uuid),
  public.landwise_application_save(jsonb), public.landwise_application_update(uuid, jsonb), public.landwise_application_remove(uuid) to authenticated;
revoke all on function public.landwise_trial_reserve(uuid, uuid), public.landwise_trial_complete(uuid, uuid, uuid, uuid),
  public.landwise_trial_release(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.landwise_trial_reserve(uuid, uuid), public.landwise_trial_complete(uuid, uuid, uuid, uuid),
  public.landwise_trial_release(uuid, uuid) to service_role;

commit;
