-- Supabase Auth identity mapping and row-level security for the Expo client.
-- Existing migrated users are linked by verified email on first Supabase sign-in.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS auth_user_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.users ALTER COLUMN password_hash DROP NOT NULL;

CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  linked_id text;
  user_name text;
BEGIN
  user_name := COALESCE(NULLIF(trim(new.raw_user_meta_data ->> 'display_name'), ''), split_part(new.email, '@', 1));

  INSERT INTO public.users (id, auth_user_id, display_name, email, password_hash, created_at)
  VALUES (new.id::text, new.id, user_name, lower(new.email), NULL, now()::text)
  ON CONFLICT (email) DO NOTHING;
  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_link_profile ON auth.users;
CREATE TRIGGER on_auth_user_created_link_profile
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();

CREATE OR REPLACE FUNCTION public.current_app_user_id()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT id FROM public.users WHERE auth_user_id = auth.uid() LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.current_app_user_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_app_user_id() TO authenticated;

CREATE OR REPLACE FUNCTION public.can_access_journey(target_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.journeys j
    WHERE j.id = target_id AND (
      j.owner_user_id = public.current_app_user_id() OR EXISTS (
        SELECT 1 FROM public.journey_members jm WHERE jm.journey_id = j.id AND jm.user_id = public.current_app_user_id()
      )
    )
  );
$$;
REVOKE ALL ON FUNCTION public.can_access_journey(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_access_journey(text) TO authenticated;

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journeys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journey_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journey_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journey_member_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journey_location_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.moderation_events ENABLE ROW LEVEL SECURITY;

-- Legacy password sessions are never used by the Expo app.
REVOKE ALL ON public.auth_sessions FROM anon, authenticated;
REVOKE ALL ON public.notification_events FROM anon, authenticated;
REVOKE ALL ON public.moderation_events FROM anon, authenticated;
REVOKE ALL ON public.users FROM anon, authenticated;

DROP POLICY IF EXISTS journey_read_for_participants ON public.journeys;
CREATE POLICY journey_read_for_participants ON public.journeys FOR SELECT TO authenticated
USING (owner_user_id = public.current_app_user_id() OR EXISTS (
  SELECT 1 WHERE public.can_access_journey(journeys.id)
));
DROP POLICY IF EXISTS journey_create_for_owner ON public.journeys;
CREATE POLICY journey_create_for_owner ON public.journeys FOR INSERT TO authenticated
WITH CHECK (owner_user_id = public.current_app_user_id());
DROP POLICY IF EXISTS journey_update_for_owner ON public.journeys;
CREATE POLICY journey_update_for_owner ON public.journeys FOR UPDATE TO authenticated
USING (owner_user_id = public.current_app_user_id())
WITH CHECK (owner_user_id = public.current_app_user_id());
DROP POLICY IF EXISTS journey_delete_for_owner ON public.journeys;
CREATE POLICY journey_delete_for_owner ON public.journeys FOR DELETE TO authenticated
USING (owner_user_id = public.current_app_user_id());

DROP POLICY IF EXISTS journey_member_read_for_participants ON public.journey_members;
CREATE POLICY journey_member_read_for_participants ON public.journey_members FOR SELECT TO authenticated
USING (user_id = public.current_app_user_id() OR public.can_access_journey(journey_id));

DROP POLICY IF EXISTS journey_messages_read_for_participants ON public.journey_messages;
CREATE POLICY journey_messages_read_for_participants ON public.journey_messages FOR SELECT TO authenticated
USING (public.can_access_journey(journey_id));
DROP POLICY IF EXISTS journey_messages_insert_for_participants ON public.journey_messages;
CREATE POLICY journey_messages_insert_for_participants ON public.journey_messages FOR INSERT TO authenticated
WITH CHECK (user_id = public.current_app_user_id() AND public.can_access_journey(journey_id));

DROP POLICY IF EXISTS member_locations_read_for_participants ON public.journey_member_locations;
CREATE POLICY member_locations_read_for_participants ON public.journey_member_locations FOR SELECT TO authenticated
USING (public.can_access_journey(journey_id));
DROP POLICY IF EXISTS member_locations_write_self ON public.journey_member_locations;
CREATE POLICY member_locations_write_self ON public.journey_member_locations FOR ALL TO authenticated
USING (user_id = public.current_app_user_id() AND public.can_access_journey(journey_id))
WITH CHECK (user_id = public.current_app_user_id() AND public.can_access_journey(journey_id));

DROP POLICY IF EXISTS location_history_read_for_participants ON public.journey_location_history;
CREATE POLICY location_history_read_for_participants ON public.journey_location_history FOR SELECT TO authenticated
USING (public.can_access_journey(journey_id));
DROP POLICY IF EXISTS location_history_insert_self ON public.journey_location_history;
CREATE POLICY location_history_insert_self ON public.journey_location_history FOR INSERT TO authenticated
WITH CHECK (user_id = public.current_app_user_id() AND public.can_access_journey(journey_id));

-- Visible, unexpired reports are public map data. Reports can be submitted by signed-in users.
DROP POLICY IF EXISTS visible_incidents_public_read ON public.incident_reports;
CREATE POLICY visible_incidents_public_read ON public.incident_reports FOR SELECT TO anon, authenticated
USING (is_visible = 1 AND expires_at::timestamptz > now());
DROP POLICY IF EXISTS community_incidents_insert ON public.incident_reports;
CREATE POLICY community_incidents_insert ON public.incident_reports FOR INSERT TO authenticated
WITH CHECK (source_type = 'community' AND verification_status = 'unverified' AND is_visible = 1
  AND created_by = public.current_app_user_id() AND reviewed_by IS NULL AND reviewed_at IS NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.journeys TO authenticated;
GRANT SELECT ON public.journey_members TO authenticated;
GRANT SELECT, INSERT ON public.journey_messages TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.journey_member_locations TO authenticated;
GRANT SELECT, INSERT ON public.journey_location_history TO authenticated;
GRANT SELECT ON public.incident_reports TO anon, authenticated;
GRANT INSERT ON public.incident_reports TO authenticated;
