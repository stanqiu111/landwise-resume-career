-- Free-launch storage limits. This migration preserves all existing rows and
-- versions, including accounts already above a limit. It never evicts resumes.
-- Payload budgets count UTF-8 JSON serialization of complete application and
-- version rows, with UTC timestamps normalized to a fixed-width representation.
-- These are logical payload limits, not a measure of PostgreSQL disk overhead.
begin;
set local time zone 'UTC';

-- Prevent writes during counter initialization and trigger installation.
lock table public.landwise_applications, public.landwise_application_versions in share row exclusive mode;

create table landwise_private.landwise_storage_global_usage (
  singleton boolean primary key default true check (singleton),
  payload_bytes bigint not null check (payload_bytes >= 0)
);
create table landwise_private.landwise_storage_user_usage (
  user_id uuid primary key,
  application_count integer not null check (application_count >= 0),
  payload_bytes bigint not null check (payload_bytes >= 0)
  -- No auth.users FK: account-deletion cascades must finish decrementing these
  -- counters even when the auth row itself is already being removed.
);
alter table landwise_private.landwise_storage_global_usage enable row level security;
alter table landwise_private.landwise_storage_user_usage enable row level security;
revoke all on landwise_private.landwise_storage_global_usage,
  landwise_private.landwise_storage_user_usage from public, anon, authenticated, service_role;

create function landwise_private.landwise_storage_payload_bytes(p_row jsonb)
returns bigint language sql stable set search_path = '' set timezone = 'UTC' as $$
  select octet_length(convert_to((p_row ||
    jsonb_build_object('created_at', to_char((p_row->>'created_at')::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) ||
    case when p_row ? 'updated_at' then
      jsonb_build_object('updated_at', to_char((p_row->>'updated_at')::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
    else '{}'::jsonb end)::text, 'UTF8'))::bigint;
$$;

insert into landwise_private.landwise_storage_user_usage(user_id, application_count, payload_bytes)
select user_id, sum(application_count)::integer, sum(payload_bytes)::bigint from (
  select a.user_id, 1 as application_count, landwise_private.landwise_storage_payload_bytes(to_jsonb(a)) as payload_bytes
    from public.landwise_applications a
  union all
  select v.user_id, 0 as application_count, landwise_private.landwise_storage_payload_bytes(to_jsonb(v)) as payload_bytes
    from public.landwise_application_versions v
) rows group by user_id;
insert into landwise_private.landwise_storage_global_usage(singleton, payload_bytes)
  select true, coalesce(sum(payload_bytes), 0)::bigint from landwise_private.landwise_storage_user_usage;

-- Statement-level locking happens before modifying application/version rows.
-- Every RPC and future direct DML path shares this lock, including cascades.
-- It prevents two accounts from both claiming the same remaining global bytes.
create function landwise_private.landwise_storage_lock()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('landwise_storage_global_v1', 0));
  return null;
end;
$$;

create function landwise_private.landwise_storage_account()
returns trigger language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  -- Explicit launch constants; change them only through a reviewed migration.
  c_application_limit constant integer := 50;
  c_version_limit constant integer := 10;
  c_user_bytes constant bigint := 5242880;       -- 5 MiB
  c_global_bytes constant bigint := 104857600;   -- 100 MiB
  c_history_limit constant integer := 100;
  v_user uuid; v_old_bytes bigint := 0; v_new_bytes bigint := 0;
  v_delta bigint; v_app_delta integer := 0;
  v_usage landwise_private.landwise_storage_user_usage;
  v_global bigint; v_previous_history integer := 0;
begin
  if tg_op <> 'INSERT' then
    v_user := old.user_id;
    v_old_bytes := landwise_private.landwise_storage_payload_bytes(to_jsonb(old));
  end if;
  if tg_op <> 'DELETE' then
    v_user := new.user_id;
    v_new_bytes := landwise_private.landwise_storage_payload_bytes(to_jsonb(new));
  end if;
  if tg_op = 'UPDATE' then
    if new.user_id <> old.user_id or new.id <> old.id then
      raise exception 'Application ownership and IDs cannot be changed.' using errcode = '22023';
    end if;
    if tg_table_name = 'landwise_application_versions' then
      if new.application_id <> old.application_id then
        raise exception 'Saved versions cannot be moved between applications.' using errcode = '22023';
      end if;
    end if;
  end if;

  if tg_table_name = 'landwise_applications' then
    if tg_op = 'INSERT' then v_app_delta := 1; end if;
    if tg_op = 'DELETE' then v_app_delta := -1; end if;
    if tg_op = 'UPDATE' then v_previous_history := jsonb_array_length(old.history); end if;
    if tg_op <> 'DELETE' and jsonb_array_length(new.history) > c_history_limit
      and jsonb_array_length(new.history) > v_previous_history then
      raise exception 'This application has reached its 100-event history limit.' using errcode = 'P0001', detail = 'landwise_history_limit';
    end if;
  elsif tg_op = 'INSERT' then
    if (select count(*) from public.landwise_application_versions where application_id = new.application_id) > c_version_limit then
      raise exception 'This application has reached its 10-version limit. Existing versions have been kept.' using errcode = 'P0001', detail = 'landwise_version_limit';
    end if;
  end if;

  v_delta := v_new_bytes - v_old_bytes;
  select payload_bytes into v_global from landwise_private.landwise_storage_global_usage where singleton for update;
  if not found then raise exception 'Cloud storage accounting is unavailable.' using errcode = '55000'; end if;
  insert into landwise_private.landwise_storage_user_usage(user_id, application_count, payload_bytes)
    values (v_user, 0, 0) on conflict (user_id) do nothing;
  select * into v_usage from landwise_private.landwise_storage_user_usage where user_id = v_user for update;
  if v_app_delta > 0 and v_usage.application_count + v_app_delta > c_application_limit then
    raise exception 'Your library has reached its 50-application limit. Remove an application before saving another.' using errcode = 'P0001', detail = 'landwise_application_limit';
  end if;
  -- Deletions and edits that do not grow the payload remain possible even for
  -- pre-existing over-limit accounts. Existing drafts are never silently cut.
  if v_delta > 0 and v_usage.payload_bytes + v_delta > c_user_bytes then
    raise exception 'Your library has reached its 5 MiB storage limit. Remove an application or shorten saved notes.' using errcode = 'P0001', detail = 'landwise_user_storage_limit';
  end if;
  if v_delta > 0 and v_global + v_delta > c_global_bytes then
    raise exception 'Cloud storage is currently full. Download your draft and try saving later.' using errcode = 'P0001', detail = 'landwise_global_storage_limit';
  end if;
  update landwise_private.landwise_storage_user_usage set application_count = application_count + v_app_delta,
    payload_bytes = payload_bytes + v_delta where user_id = v_user;
  update landwise_private.landwise_storage_global_usage set payload_bytes = payload_bytes + v_delta where singleton;
  delete from landwise_private.landwise_storage_user_usage where user_id = v_user and application_count = 0 and payload_bytes = 0;
  return null;
end;
$$;

-- AFTER ROW excludes unsuccessful INSERT ... ON CONFLICT DO NOTHING attempts,
-- so retrying a saved draft at the app/version limit remains idempotent.
create trigger landwise_storage_lock before insert or update or delete
  on public.landwise_applications for each statement execute function landwise_private.landwise_storage_lock();
create trigger landwise_storage_account after insert or update or delete
  on public.landwise_applications for each row execute function landwise_private.landwise_storage_account();
create trigger landwise_storage_lock before insert or update or delete
  on public.landwise_application_versions for each statement execute function landwise_private.landwise_storage_lock();
create trigger landwise_storage_account after insert or update or delete
  on public.landwise_application_versions for each row execute function landwise_private.landwise_storage_account();

revoke all on function landwise_private.landwise_storage_payload_bytes(jsonb),
  landwise_private.landwise_storage_lock(), landwise_private.landwise_storage_account()
  from public, anon, authenticated, service_role;

commit;
