-- Undo 202610200001_landwise_guest_trials.sql: restores the original status,
-- reserve and upload function bodies from 202610170002_landwise_ai_budget.sql
-- (1 guest success for life, 3 attempts per IP hash per UTC day, 10 per UTC day,
-- 100 per UTC month, US$4 monthly budget, uploads 10/guest, 10/IP, 100/day).
-- Run this in the SQL Editor BEFORE restoring any deployment older than the
-- guest-trial change: older servers reject a status above 3 remaining.
-- Existing ledger rows are kept; guests with more than one success simply have
-- no remaining allowance afterwards. Not a migration: never place it in
-- supabase/migrations.
begin;

create or replace function public.landwise_upload_acquire(p_guest_hash text, p_ip_hash text)
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

create or replace function public.landwise_ai_status(p_user_id uuid default null, p_guest_hash text default null)
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

create or replace function public.landwise_ai_reserve(
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

revoke all on function public.landwise_ai_status(uuid,text),
  public.landwise_ai_reserve(uuid,uuid,text,text,text,bigint,text), public.landwise_upload_acquire(text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.landwise_ai_status(uuid,text),
  public.landwise_ai_reserve(uuid,uuid,text,text,text,bigint,text), public.landwise_upload_acquire(text,text) to service_role;

commit;
