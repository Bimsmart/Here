# Here mobile (Expo)

This folder is the Expo client. It uses Supabase Auth and the existing Supabase
PostgreSQL database directly. Do not place a database URL or Supabase service
role key in this app; only the project URL and publishable key belong in the
Expo public environment.

## Start locally

1. Copy `.env.example` to `.env` and fill in `EXPO_PUBLIC_SUPABASE_URL` and
   `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` from the Supabase project settings.
2. The current Supabase project already has the SQL migrations applied. To
   deploy the account-link function, install the repo's CLI dependency with
   `npm install` from the repository root, then run `npx supabase login` and
   `npx supabase functions deploy link-legacy-account --project-ref YOUR_PROJECT_REF --use-api`.
   The project ref is the part before `.supabase.co` in the Project URL.
3. From this folder, run `npm install`, then `npx expo start`.

The first screen supports email/password accounts, lists the signed-in user's
journeys, and creates a journey by tapping a destination on the map. It can use
device location as the optional origin. Existing local accounts link to
Supabase Auth after email confirmation and a server-side check of their old
password. New accounts can confirm their email before signing in.

## Current scope

This is the initial native client foundation. Live location, participant
invitations/chat, report moderation, scheduled overdue notifications, and store
builds still need their Expo/Supabase implementations.
The legacy FastAPI app remains in the repository for local web development;
the mobile client does not call it.
