-- One current GPS point per sharer; remove abandoned sessions automatically.
-- Public reads already hide points older than two minutes immediately.
create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

select cron.schedule(
  'ju-expired-bus-shares',
  '* * * * *',
  $$delete from ju_private.bus_shares
    where coalesce(fix_at, started_at) < now() - interval '2 minutes'
       or started_at < now() - interval '4 hours';$$
);
