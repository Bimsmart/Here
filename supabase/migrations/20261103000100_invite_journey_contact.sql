-- Let a journey owner add the account matching the trusted contact email.
-- The contact email is checked server-side so the mobile client never reads
-- the protected users table directly.
CREATE OR REPLACE FUNCTION public.invite_journey_contact(target_journey_id text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  owner_id text;
  trusted_email text;
  contact_user_id text;
BEGIN
  owner_id := public.current_app_user_id();
  IF owner_id IS NULL THEN
    RAISE EXCEPTION 'Sign in before sharing a journey';
  END IF;

  SELECT j.contact_email INTO trusted_email
  FROM public.journeys AS j
  WHERE j.id = target_journey_id
    AND j.owner_user_id = owner_id
    AND j.status IN ('ACTIVE', 'OVERDUE_PENDING', 'OVERDUE_NOTIFIED');

  IF trusted_email IS NULL THEN
    RAISE EXCEPTION 'Active journey not found';
  END IF;

  SELECT u.id INTO contact_user_id
  FROM public.users AS u
  WHERE pg_catalog.lower(u.email) = pg_catalog.lower(trusted_email)
  LIMIT 1;

  IF contact_user_id IS NULL THEN
    RETURN 'account_not_found';
  END IF;

  IF contact_user_id = owner_id THEN
    RETURN 'same_account';
  END IF;

  INSERT INTO public.journey_members (journey_id, user_id, joined_at)
  VALUES (target_journey_id, contact_user_id, pg_catalog.now()::text)
  ON CONFLICT (journey_id, user_id) DO NOTHING;

  RETURN 'invited';
END;
$$;

REVOKE ALL ON FUNCTION public.invite_journey_contact(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.invite_journey_contact(text) TO authenticated;
