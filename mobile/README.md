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

The app supports email/password accounts, journey creation with place search
and an estimated driving arrival time, trusted-contact sharing, foreground
live location sharing, journey chat, and community incident reports on a map.
Existing local accounts link to Supabase Auth after email confirmation and a
server-side check of their old password. New accounts can confirm their email
before signing in.

## Current scope

Report moderation, overdue email delivery, and store builds still need their
Expo/Supabase implementations. The database scheduler marks journeys overdue
and queues notification events, but an email provider still needs to be
connected before trusted contacts receive overdue emails. Live location is
shared only while Here is open in the foreground; it stops when the user taps
Stop live location or marks the journey arrived or cancelled.
The legacy FastAPI app remains in the repository for local web development;
the mobile client does not call it.
