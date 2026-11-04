-- Keep journey check-in deadlines running even when the mobile app is closed.
CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE OR REPLACE FUNCTION public.process_overdue_journeys()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  now_at timestamptz := pg_catalog.now();
  existing_job bigint;
BEGIN
  UPDATE public.journeys
  SET status = 'OVERDUE_PENDING', updated_at = now_at::text
  WHERE status = 'ACTIVE'
    AND eta::timestamptz <= now_at;

  INSERT INTO public.notification_events
    (id, journey_id, idempotency_key, status, created_at, next_attempt_at)
  SELECT
    pg_catalog.gen_random_uuid()::text,
    j.id,
    j.id || ':' || j.eta,
    'PENDING',
    now_at::text,
    now_at::text
  FROM public.journeys AS j
  WHERE j.status IN ('OVERDUE_PENDING', 'OVERDUE_NOTIFIED')
    AND j.eta::timestamptz
      + pg_catalog.make_interval(secs => j.grace_period_seconds) <= now_at
  ON CONFLICT (idempotency_key) DO NOTHING;

  UPDATE public.notification_events AS n
  SET status = 'CANCELLED'
  FROM public.journeys AS j
  WHERE n.journey_id = j.id
    AND n.status IN ('PENDING', 'FAILED')
    AND (
      j.status IN ('ACTIVE', 'ARRIVED', 'CANCELLED')
      OR n.idempotency_key <> j.id || ':' || j.eta
    );
END;
$$;

REVOKE ALL ON FUNCTION public.process_overdue_journeys() FROM PUBLIC;

DO $$
DECLARE
  existing_job bigint;
BEGIN
  SELECT jobid INTO existing_job
  FROM cron.job
  WHERE jobname = 'here-overdue-checkins';

  IF existing_job IS NOT NULL THEN
    PERFORM cron.unschedule(existing_job);
  END IF;

  PERFORM cron.schedule(
    'here-overdue-checkins',
    '* * * * *',
    'SELECT public.process_overdue_journeys()'
  );
END;
$$;
