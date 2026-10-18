-- Sponsored API pilot: US$4/month committed budget with US$1 billing margin.
-- All RPCs are server-only. The server verifies Supabase users, validates signed
-- guest cookies, hashes trusted IP addresses, and computes costs from provider
-- usage. Nothing here trusts client-supplied identity, tokens, prices or usage.
begin;

create table landwise_private.landwise_ai_months (
  month date primary key,
  attempts integer not null default 0 check (attempts >= 0),
  committed_microusd bigint not null default 0 check (committed_microusd >= 0)
);
create table landwise_private.landwise_ai_days (
  day date primary key,
  attempts integer not null default 0 check (attempts >= 0)
);
create table landwise_private.landwise_ai_ip_days (
  day date not null,
  ip_hash text not null check (ip_hash ~ '^[a-f0-9]{64}$'),
  attempts integer not null default 0 check (attempts >= 0),
  primary key (day, ip_hash)
);
create table landwise_private.landwise_ai_entitlements (
  actor_key text not null,
  month date not null,
  successful_jobs integer not null default 0 check (successful_jobs >= 0),
  primary key (actor_key, month)
);
create table landwise_private.landwise_ai_jobs (
  id uuid primary key default gen_random_uuid(),
  actor_key text not null,
  request_id uuid not null,
  input_hash text not null check (input_hash ~ '^[a-f0-9]{64}$'),
  ip_hash text not null check (ip_hash ~ '^[a-f0-9]{64}$'),
  operation text not null check (operation in ('transform', 'revise', 'analyze')),
  status text not null check (status in ('reserved', 'completed', 'failed')),
  reservation_month date not null,
  reserved_cost_microusd bigint not null check (reserved_cost_microusd between 1 and 4000000),
  charged_cost_microusd bigint check (charged_cost_microusd >= 0),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  unique (actor_key, request_id),
  check ((status = 'reserved' and charged_cost_microusd is null and settled_at is null)
    or (status <> 'reserved' and charged_cost_microusd is not null and settled_at is not null))
);
create unique index landwise_ai_one_active_job on landwise_private.landwise_ai_jobs((true)) where status = 'reserved';
create table landwise_private.landwise_ai_results (
  job_id uuid primary key references landwise_private.landwise_ai_jobs(id) on delete cascade,
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  payload_bytes integer not null check (payload_bytes between 1 and 220000),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index landwise_ai_results_expiry on landwise_private.landwise_ai_results(expires_at, created_at);
create table landwise_private.landwise_upload_days (
  day date not null,
  scope text not null,
  attempts integer not null default 0 check (attempts >= 0),
  primary key (day, scope)
);

alter table landwise_private.landwise_ai_months enable row level security;
alter table landwise_private.landwise_ai_days enable row level security;
alter table landwise_private.landwise_ai_ip_days enable row level security;
alter table landwise_private.landwise_ai_entitlements enable row level security;
alter table landwise_private.landwise_ai_jobs enable row level security;
alter table landwise_private.landwise_ai_results enable row level security;
alter table landwise_private.landwise_upload_days enable row level security;
revoke all on landwise_private.landwise_ai_months, landwise_private.landwise_ai_days,
  landwise_private.landwise_ai_ip_days, landwise_private.landwise_ai_entitlements,
  landwise_private.landwise_ai_jobs, landwise_private.landwise_ai_results,
  landwise_private.landwise_upload_days from public, anon, authenticated, service_role;

create function public.landwise_upload_acquire(p_guest_hash text, p_ip_hash text)
returns boolean language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare v_day date; v_scope text;
begin
  if p_guest_hash is null or p_guest_hash !~ '^[a-f0-9]{64}$' or p_ip_hash is null or p_ip_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Verified upload identities are required.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('landwise_upload_budget_v1', 0));
  v_day := (clock_timestamp() at time zone 'UTC')::date;
  delete from landwise_private.landwise_upload_days where day < v_day - 2;
  foreach v_scope in array array['global', 'ip:' || p_ip_hash, 'guest:' || p_guest_hash] loop
    insert into landwise_private.landwise_upload_days(day, scope) values (v_day, v_scope) on conflict do nothing;
    if (select attempts from landwise_private.landwise_upload_days where day = v_day and scope = v_scope) >= (case when v_scope = 'global' then 100 else 10 end) then
      raise exception 'The daily PDF upload limit has been reached. Paste resume text or try again tomorrow.' using errcode = 'P0001', detail = 'landwise_upload_limit';
    end if;
  end loop;
  update landwise_private.landwise_upload_days set attempts = attempts + 1
    where day = v_day and scope in ('global', 'ip:' || p_ip_hash, 'guest:' || p_guest_hash);
  return true;
end;
$$;

create function landwise_private.landwise_ai_actor(p_user_id uuid, p_guest_hash text)
returns text language plpgsql stable set search_path = '' as $$
begin
  if (p_user_id is null) = (p_guest_hash is null) then
    raise exception 'Exactly one verified actor is required.' using errcode = '22023';
  end if;
  if p_user_id is not null then
    -- Caller must first verify the end-user JWT/confirmed account with Auth.
    -- The service-only boundary prevents a browser from asserting this ID.
    if not exists (select 1 from auth.users where id = p_user_id) then
      raise exception 'Verified user does not exist.' using errcode = '22023';
    end if;
    return 'user:' || p_user_id::text;
  end if;
  if p_guest_hash !~ '^[a-f0-9]{64}$' then raise exception 'Invalid guest identity hash.' using errcode = '22023'; end if;
  return 'guest:' || p_guest_hash;
end;
$$;

create function landwise_private.landwise_ai_receipt(p_job landwise_private.landwise_ai_jobs, p_admitted boolean default false)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'jobId', p_job.id, 'status', p_job.status, 'admitted', p_admitted,
    'reservedCostMicrousd', p_job.reserved_cost_microusd,
    'chargedCostMicrousd', p_job.charged_cost_microusd,
    'result', (select result from landwise_private.landwise_ai_results where job_id = p_job.id and expires_at > clock_timestamp()),
    'resultUnavailable', case when p_job.status = 'completed' then not exists (
      select 1 from landwise_private.landwise_ai_results where job_id = p_job.id and expires_at > clock_timestamp()) else null end
  ));
$$;

create function public.landwise_ai_status(p_user_id uuid default null, p_guest_hash text default null)
returns jsonb language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  v_actor text; v_month date; v_day date; v_period date; v_success integer;
  v_remaining integer; v_guest boolean; v_reason text;
begin
  v_actor := landwise_private.landwise_ai_actor(p_user_id, p_guest_hash);
  perform pg_advisory_xact_lock(hashtextextended('landwise_ai_budget_v1', 0));
  v_day := (clock_timestamp() at time zone 'UTC')::date;
  v_month := date_trunc('month', v_day)::date;
  v_guest := p_user_id is null;
  v_period := case when v_guest then date '0001-01-01' else v_month end;
  delete from landwise_private.landwise_ai_results where expires_at <= clock_timestamp();
  select successful_jobs into v_success from landwise_private.landwise_ai_entitlements where actor_key = v_actor and month = v_period;
  v_remaining := greatest(0, (case when v_guest then 1 else 3 end) - coalesce(v_success, 0));
  if v_remaining = 0 then v_reason := case when v_guest then 'guest_trial_used' else 'monthly_allowance' end;
  elsif exists (select 1 from landwise_private.landwise_ai_jobs where status = 'reserved') then v_reason := 'ai_busy';
  elsif coalesce((select committed_microusd from landwise_private.landwise_ai_months where month = v_month), 0) + 60000 > 4000000 then v_reason := 'monthly_budget';
  elsif coalesce((select attempts from landwise_private.landwise_ai_days where day = v_day), 0) >= 10 then v_reason := 'daily_limit';
  elsif coalesce((select attempts from landwise_private.landwise_ai_months where month = v_month), 0) >= 100 then v_reason := 'monthly_limit';
  end if;
  return jsonb_strip_nulls(jsonb_build_object('guestEligible', v_guest and v_remaining > 0,
    'remaining', v_remaining, 'available', v_reason is null, 'reason', v_reason));
end;
$$;

create function public.landwise_ai_reserve(
  p_request_id uuid, p_user_id uuid, p_guest_hash text, p_ip_hash text,
  p_input_hash text, p_max_cost_microusd bigint, p_operation text default 'transform')
returns jsonb language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  v_actor text; v_day date; v_month date; v_period date; v_job landwise_private.landwise_ai_jobs;
  v_attempts integer; v_committed bigint; v_success integer;
begin
  v_actor := landwise_private.landwise_ai_actor(p_user_id, p_guest_hash);
  if p_request_id is null or p_ip_hash is null or p_ip_hash !~ '^[a-f0-9]{64}$'
    or p_input_hash is null or p_input_hash !~ '^[a-f0-9]{64}$'
    or p_max_cost_microusd is null or p_max_cost_microusd not between 1 and 4000000
    or p_operation is null or p_operation not in ('transform', 'revise', 'analyze') then
    raise exception 'Invalid sponsored request.' using errcode = '22023';
  end if;
  if p_user_id is null and p_operation <> 'transform' then
    raise exception 'Sign in before using follow-up or analysis.' using errcode = 'P0001', detail = 'landwise_ai_sign_in_required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('landwise_ai_budget_v1', 0));
  v_day := (clock_timestamp() at time zone 'UTC')::date;
  v_month := date_trunc('month', v_day)::date;
  v_period := case when p_user_id is null then date '0001-01-01' else v_month end;
  delete from landwise_private.landwise_ai_results where expires_at <= clock_timestamp();

  select * into v_job from landwise_private.landwise_ai_jobs where actor_key = v_actor and request_id = p_request_id;
  if found then
    if v_job.input_hash <> p_input_hash or v_job.operation <> p_operation then
      raise exception 'This request ID already belongs to different input.' using errcode = 'P0001', detail = 'landwise_ai_idempotency_conflict';
    end if;
    return landwise_private.landwise_ai_receipt(v_job);
  end if;
  select successful_jobs into v_success from landwise_private.landwise_ai_entitlements where actor_key = v_actor and month = v_period;
  if coalesce(v_success, 0) >= (case when p_user_id is null then 1 else 3 end) then
    raise exception 'Your sponsored allowance has been used.' using errcode = 'P0001', detail = 'landwise_ai_allowance_used';
  end if;
  -- No lease expires automatically. A crashed/unknown worker remains blocked
  -- until an operator confirms it has stopped and settles it conservatively.
  if exists (select 1 from landwise_private.landwise_ai_jobs where status = 'reserved') then
    raise exception 'Another AI request is still running or awaiting reconciliation.' using errcode = 'P0001', detail = 'landwise_ai_busy';
  end if;
  insert into landwise_private.landwise_ai_months(month) values (v_month) on conflict do nothing;
  insert into landwise_private.landwise_ai_days(day) values (v_day) on conflict do nothing;
  insert into landwise_private.landwise_ai_ip_days(day, ip_hash) values (v_day, p_ip_hash) on conflict do nothing;
  select attempts, committed_microusd into v_attempts, v_committed from landwise_private.landwise_ai_months where month = v_month;
  if v_attempts >= 100 then raise exception 'The pilot monthly request limit has been reached.' using errcode = 'P0001', detail = 'landwise_ai_monthly_limit'; end if;
  if v_committed + p_max_cost_microusd > 4000000 then raise exception 'The pilot monthly AI budget has been reached.' using errcode = 'P0001', detail = 'landwise_ai_budget_limit'; end if;
  if (select attempts from landwise_private.landwise_ai_days where day = v_day) >= 10 then
    raise exception 'The pilot daily request limit has been reached.' using errcode = 'P0001', detail = 'landwise_ai_daily_limit';
  end if;
  if (select attempts from landwise_private.landwise_ai_ip_days where day = v_day and ip_hash = p_ip_hash) >= 3 then
    raise exception 'The daily request limit for this connection has been reached.' using errcode = 'P0001', detail = 'landwise_ai_ip_limit';
  end if;
  update landwise_private.landwise_ai_months set attempts = attempts + 1,
    committed_microusd = committed_microusd + p_max_cost_microusd where month = v_month;
  update landwise_private.landwise_ai_days set attempts = attempts + 1 where day = v_day;
  update landwise_private.landwise_ai_ip_days set attempts = attempts + 1 where day = v_day and ip_hash = p_ip_hash;
  insert into landwise_private.landwise_ai_jobs(actor_key, request_id, input_hash, ip_hash, operation, status, reservation_month, reserved_cost_microusd)
    values (v_actor, p_request_id, p_input_hash, p_ip_hash, p_operation, 'reserved', v_month, p_max_cost_microusd)
    returning * into v_job;
  return landwise_private.landwise_ai_receipt(v_job, true);
end;
$$;

create function landwise_private.landwise_ai_settle(p_job_id uuid, p_actual_cost_microusd bigint, p_completed boolean, p_result jsonb)
returns jsonb language plpgsql set search_path = '' set timezone = 'UTC' as $$
declare
  v_job landwise_private.landwise_ai_jobs; v_charge bigint; v_now timestamptz;
  v_period date; v_bytes integer; v_cached bigint; v_evict uuid;
begin
  if p_job_id is null or p_actual_cost_microusd < 0 or p_actual_cost_microusd > 100000000 then
    raise exception 'Invalid job settlement.' using errcode = '22023';
  end if;
  if p_result is not null and jsonb_typeof(p_result) <> 'object' then
    raise exception 'The recovery result must be an object.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('landwise_ai_budget_v1', 0));
  v_now := clock_timestamp();
  select * into v_job from landwise_private.landwise_ai_jobs where id = p_job_id for update;
  if not found then raise exception 'This AI job does not exist.' using errcode = 'P0002'; end if;
  if v_job.status <> 'reserved' then return landwise_private.landwise_ai_receipt(v_job); end if;
  v_charge := coalesce(p_actual_cost_microusd, v_job.reserved_cost_microusd);
  -- Actual usage is accepted only from the trusted server. Unknown usage keeps
  -- the entire reservation. A provider overrun is recorded, never hidden; the
  -- exhausted monthly balance then prevents all further admissions.
  update landwise_private.landwise_ai_months set committed_microusd = committed_microusd + v_charge - v_job.reserved_cost_microusd
    where month = v_job.reservation_month;
  update landwise_private.landwise_ai_jobs set status = case when p_completed then 'completed' else 'failed' end,
    charged_cost_microusd = v_charge, settled_at = v_now where id = p_job_id returning * into v_job;
  if p_completed then
    v_period := case when v_job.actor_key like 'guest:%' then date '0001-01-01' else date_trunc('month', v_now at time zone 'UTC')::date end;
    insert into landwise_private.landwise_ai_entitlements(actor_key, month, successful_jobs)
      values (v_job.actor_key, v_period, 1)
      on conflict (actor_key, month) do update set successful_jobs = landwise_private.landwise_ai_entitlements.successful_jobs + 1;
    delete from landwise_private.landwise_ai_results where expires_at <= v_now;
    v_bytes := case when p_result is not null then octet_length(convert_to(p_result::text, 'UTF8')) end;
    -- Oversized results still settle success/spending; they simply cannot be
    -- recovered from the cache. The worker already has the result to deliver.
    if v_bytes between 1 and 220000 then
      select coalesce(sum(payload_bytes), 0) into v_cached from landwise_private.landwise_ai_results;
      while v_cached + v_bytes > 10485760 loop
        select job_id into v_evict from landwise_private.landwise_ai_results order by created_at, job_id limit 1;
        delete from landwise_private.landwise_ai_results where job_id = v_evict;
        select coalesce(sum(payload_bytes), 0) into v_cached from landwise_private.landwise_ai_results;
      end loop;
      insert into landwise_private.landwise_ai_results(job_id, result, payload_bytes, expires_at, created_at)
        values (p_job_id, p_result, v_bytes, v_now + interval '7 days', v_now);
    end if;
  end if;
  return landwise_private.landwise_ai_receipt(v_job);
end;
$$;

create function public.landwise_ai_complete(p_job_id uuid, p_actual_cost_microusd bigint default null, p_result jsonb default null)
returns jsonb language sql security definer set search_path = '' as $$
  select landwise_private.landwise_ai_settle(p_job_id, p_actual_cost_microusd, true, p_result);
$$;
create function public.landwise_ai_fail(p_job_id uuid, p_actual_cost_microusd bigint default null)
returns jsonb language sql security definer set search_path = '' as $$
  select landwise_private.landwise_ai_settle(p_job_id, p_actual_cost_microusd, false, null);
$$;

revoke all on function landwise_private.landwise_ai_actor(uuid,text),
  landwise_private.landwise_ai_receipt(landwise_private.landwise_ai_jobs,boolean),
  landwise_private.landwise_ai_settle(uuid,bigint,boolean,jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.landwise_ai_status(uuid,text),
  public.landwise_ai_reserve(uuid,uuid,text,text,text,bigint,text),
  public.landwise_ai_complete(uuid,bigint,jsonb), public.landwise_ai_fail(uuid,bigint), public.landwise_upload_acquire(text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.landwise_ai_status(uuid,text),
  public.landwise_ai_reserve(uuid,uuid,text,text,text,bigint,text),
  public.landwise_ai_complete(uuid,bigint,jsonb), public.landwise_ai_fail(uuid,bigint), public.landwise_upload_acquire(text,text) to service_role;

commit;
