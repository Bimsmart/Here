-- Account linking now verifies the legacy password in a server-side Edge Function.
DROP FUNCTION IF EXISTS public.link_legacy_account();
