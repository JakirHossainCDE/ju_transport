-- Run as the database owner. No service key is used by the website.
-- The private tables cannot be accessed through the public Data API.
begin;
create schema if not exists ju_private;
revoke all on schema ju_private from public, anon, authenticated;

create table ju_private.authorities (
  user_id uuid primary key references auth.users(id) on delete cascade,
  approved_at timestamptz not null default now()
);
create table ju_private.bus_shares (
  user_id uuid primary key references auth.users(id) on delete cascade,
  session_id uuid not null unique,
  route_id text not null check (route_id in ('1','2','3','4','5','6','7')),
  direction text not null check (direction in ('to-campus','from-campus')),
  bus_label text not null check (
    char_length(bus_label) between 1 and 32 and bus_label !~ '[[:cntrl:]]'
  ),
  latitude double precision,
  longitude double precision,
  accuracy double precision,
  fix_at timestamptz,
  updated_at timestamptz,
  started_at timestamptz not null default clock_timestamp(),
  check (latitude between 23.4 and 24.2),
  check (longitude between 90.05 and 90.7),
  check (accuracy between 0 and 200)
);
create index bus_shares_fix_at_idx on ju_private.bus_shares(fix_at desc);
alter table ju_private.authorities enable row level security;
alter table ju_private.bus_shares enable row level security;
revoke all on all tables in schema ju_private from public, anon, authenticated;

-- Only approved identities receive the authority badge. User metadata is never trusted.
create function ju_private.ju_share_identity() returns text
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sign in required' using errcode = '42501'; end if;
  if exists(select 1 from ju_private.authorities where user_id = auth.uid()) then
    return 'authority';
  end if;
  return 'community';
end;
$$;

-- Starting again replaces only the caller's previous session. An old device's
-- delayed update/stop cannot change the new session because its UUID no longer matches.
create function ju_private.ju_start_share(p_session_id uuid, p_route_id text,
  p_direction text, p_bus_label text) returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sign in required' using errcode = '42501'; end if;
  insert into ju_private.bus_shares(user_id, session_id, route_id, direction, bus_label)
  values(auth.uid(), p_session_id, p_route_id, p_direction, trim(p_bus_label))
  on conflict(user_id) do update set
    session_id = excluded.session_id, route_id = excluded.route_id,
    direction = excluded.direction, bus_label = excluded.bus_label,
    latitude = null, longitude = null, accuracy = null, fix_at = null,
    updated_at = null, started_at = clock_timestamp();
  return p_session_id;
end;
$$;

create function ju_private.ju_publish_location(p_session_id uuid, p_latitude double precision,
  p_longitude double precision, p_accuracy double precision, p_age_ms integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  current_share ju_private.bus_shares%rowtype;
  stamp timestamptz := clock_timestamp();
begin
  if auth.uid() is null then raise exception 'Sign in required' using errcode = '42501'; end if;
  if p_latitude is null or p_longitude is null or p_accuracy is null or p_age_ms is null
    or not (p_latitude between 23.4 and 24.2)
    or not (p_longitude between 90.05 and 90.7)
    or not (p_accuracy between 0 and 200)
    or not (p_age_ms between 0 and 20000) then
    raise exception 'Invalid or old GPS fix' using errcode = '22023';
  end if;
  select * into current_share from ju_private.bus_shares
    where user_id = auth.uid() and session_id = p_session_id for update;
  if not found or current_share.started_at < stamp - interval '4 hours' then
    raise exception 'Sharing session ended' using errcode = 'P0002';
  end if;
  if current_share.updated_at > stamp - interval '8 seconds' then
    return jsonb_build_object('accepted', false, 'fix_at', current_share.fix_at);
  end if;
  -- Never upsert here: Stop deletes the row, so a delayed GPS write cannot revive it.
  update ju_private.bus_shares set latitude = p_latitude, longitude = p_longitude,
    accuracy = p_accuracy, updated_at = stamp,
    fix_at = stamp - p_age_ms * interval '1 millisecond'
    where user_id = auth.uid() and session_id = p_session_id;
  return jsonb_build_object('accepted', true,
    'fix_at', stamp - p_age_ms * interval '1 millisecond');
end;
$$;

create function ju_private.ju_stop_share(p_session_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sign in required' using errcode = '42501'; end if;
  delete from ju_private.bus_shares where user_id = auth.uid() and session_id = p_session_id;
  return true;
end;
$$;

-- Public output omits owner IDs, email addresses, auth metadata and previous points.
-- Expiry is enforced on EVERY read; it does not depend on a phone sending Stop.
create function ju_private.ju_live_buses() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('server_time', now(), 'buses', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.session_id, 'route_id', s.route_id, 'direction', s.direction,
      'bus_label', s.bus_label, 'latitude', s.latitude, 'longitude', s.longitude,
      'accuracy', s.accuracy, 'fix_at', s.fix_at,
      'source', case when a.user_id is null then 'community' else 'authority' end
    ) order by s.fix_at desc)
    from ju_private.bus_shares s
    left join ju_private.authorities a on a.user_id = s.user_id
    where s.fix_at > now() - interval '2 minutes'
      and s.fix_at <= now() + interval '1 second'
      and s.started_at > now() - interval '4 hours'
      and s.latitude is not null and s.longitude is not null
  ), '[]'::jsonb));
$$;

-- Public wrappers run as the caller. Privileged code stays in the unexposed schema.
create function public.ju_share_identity() returns text
language sql security invoker set search_path = '' as $$ select ju_private.ju_share_identity(); $$;
create function public.ju_start_share(p_session_id uuid,p_route_id text,p_direction text,p_bus_label text) returns uuid
language sql security invoker set search_path = '' as $$ select ju_private.ju_start_share(p_session_id,p_route_id,p_direction,p_bus_label); $$;
create function public.ju_publish_location(p_session_id uuid,p_latitude double precision,p_longitude double precision,p_accuracy double precision,p_age_ms integer) returns jsonb
language sql security invoker set search_path = '' as $$ select ju_private.ju_publish_location(p_session_id,p_latitude,p_longitude,p_accuracy,p_age_ms); $$;
create function public.ju_stop_share(p_session_id uuid) returns boolean
language sql security invoker set search_path = '' as $$ select ju_private.ju_stop_share(p_session_id); $$;
create function public.ju_live_buses() returns jsonb
language sql stable security invoker set search_path = '' as $$ select ju_private.ju_live_buses(); $$;

-- Schema usage permits these calls, but gives no table access. Do not expose ju_private in Data API settings.
grant usage on schema ju_private to anon, authenticated;
revoke all on all functions in schema ju_private from public, anon, authenticated;
grant execute on function ju_private.ju_share_identity() to authenticated;
grant execute on function ju_private.ju_start_share(uuid,text,text,text) to authenticated;
grant execute on function ju_private.ju_publish_location(uuid,double precision,double precision,double precision,integer) to authenticated;
grant execute on function ju_private.ju_stop_share(uuid) to authenticated;
grant execute on function ju_private.ju_live_buses() to anon, authenticated;
revoke all on function public.ju_share_identity() from public, anon, authenticated;
revoke all on function public.ju_start_share(uuid,text,text,text) from public, anon, authenticated;
revoke all on function public.ju_publish_location(uuid,double precision,double precision,double precision,integer) from public, anon, authenticated;
revoke all on function public.ju_stop_share(uuid) from public, anon, authenticated;
revoke all on function public.ju_live_buses() from public, anon, authenticated;
grant execute on function public.ju_share_identity() to authenticated;
grant execute on function public.ju_start_share(uuid,text,text,text) to authenticated;
grant execute on function public.ju_publish_location(uuid,double precision,double precision,double precision,integer) to authenticated;
grant execute on function public.ju_stop_share(uuid) to authenticated;
grant execute on function public.ju_live_buses() to anon, authenticated;
commit;
