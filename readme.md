# GeoPresence

**A geospatial personal-safety application for journey check-ins and
trusted-contact notifications.**

GeoPresence helps people share a planned journey with someone they
trust, confirm arrival, and trigger a follow-up notification when an
expected check-in is missed.

> **Project status:** Proposed MVP / development specification. Features
> described here are planned functionality unless implemented in the
> project repository.

> **Local implementation:** This workspace includes a FastAPI prototype with
> SQLite persistence, traveller accounts, a Leaflet journey map, manual
> arrival confirmation and ETA extension controls, trip sharing between existing accounts, participant
> chat, opt-in live location, historical trip views, and KML export. It also
> supports incident submissions, source links, route-buffer matching, report
> expiry, and moderator-only report controls with an audit history. Without
> SMTP settings, overdue events are recorded locally and no contact email is
> sent. The app is intended for localhost development and is not suitable for
> real safety monitoring or exposure to an untrusted network.

## Table of Contents

-   [1. Overview](#1-overview)
-   [2. Problem Statement](#2-problem-statement)
-   [3. Proposed Solution](#3-proposed-solution)
-   [4. Target Users](#4-target-users)
-   [5. Core Features](#5-core-features)
-   [6. User Workflow](#6-user-workflow)
-   [7. Technology Stack](#7-technology-stack)
-   [8. High-Level Architecture](#8-high-level-architecture)
-   [9. Data Requirements](#9-data-requirements)
-   [10. MVP Scope](#10-mvp-scope)
-   [11. Installation and Local
    Development](#11-installation-and-local-development)
-   [12. Configuration](#12-configuration)
-   [13. Testing Scenarios](#13-testing-scenarios)
-   [14. Privacy and Safety](#14-privacy-and-safety)
-   [15. Limitations](#15-limitations)
-   [16. Future Enhancements](#16-future-enhancements)
-   [17. Contribution and License](#17-contribution-and-license)

## 1. Overview

GeoPresence combines geographic location, expected arrival time,
user-confirmed check-ins, and trusted-contact notifications in one
workflow.

The guiding question is:

**"Are you there?"**

A user creates a journey, selects a destination and expected arrival
time, and nominates a trusted contact. The user can confirm arrival or
extend the expected arrival time. If the journey becomes overdue, the
system prompts the user and can notify the trusted contact after a
configurable grace period.

GeoPresence is designed to support timely follow-up. It does **not**
determine that a user is in danger solely because a check-in is missed.

## 2. Problem Statement

People travelling alone, visiting unfamiliar locations, or carrying out
field work may not have a structured way to confirm arrival to someone
they trust. When an expected check-in is missed, the absence of timely
information can delay follow-up.

GeoPresence proposes a geospatial check-in and journey-monitoring system
that allows users to share journey expectations, confirm arrival, and
notify trusted contacts when a planned check-in is overdue.

## 3. Proposed Solution

GeoPresence provides a lightweight web application for:

1.  Creating a journey with an origin, destination, and expected arrival
    time.
2.  Sharing journey details with a chosen trusted contact.
3.  Recording a manual check-in or arrival confirmation.
4.  Detecting overdue check-ins using time-based rules.
5.  Sending an overdue notification with the last available, authorized
    location and its timestamp.
6.  Allowing users to cancel a journey or stop sharing.

The first version should focus on one reliable end-to-end journey rather
than continuous tracking, automated emergency dispatch, or predictive
AI.

## 4. Target Users

-   **Individuals and commuters:** people travelling alone or to
    unfamiliar locations.
-   **Students:** people travelling between campus, home, and other
    destinations.
-   **Field workers:** surveyors, technicians, sales personnel, and
    other mobile workers.
-   **Delivery personnel:** workers who need to confirm arrival at a
    destination.
-   **Trusted contacts:** friends, relatives, or colleagues who receive
    journey updates.

The initial MVP should prioritize individual travellers and their
trusted contacts.

## 5. Core Features

  -----------------------------------------------------------------------
  Feature                 Description             MVP priority
  ----------------------- ----------------------- -----------------------
  Journey creation        Enter destination,      Must have
                          origin, and expected    
                          arrival time            

  Interactive map         Display user location   Must have
                          and destination         

  Trusted contact         Select or enter a       Must have
                          contact for journey     
                          updates                 

  Arrival check-in        Confirm arrival         Must have
                          manually                

  ETA extension           Update expected arrival Must have
                          time                    

  Overdue detection       Apply a grace period    Must have
                          and mark a journey      
                          overdue                 

  Contact notification    Send an overdue         Must have
                          notification            

  Journey status          Active, arrived,        Must have
                          overdue, cancelled      

  Privacy controls        Stop sharing and end a  Must have
                          journey                 

  Live location history   Store repeated location Later
                          updates                 

  SMS/phone escalation    Send SMS or place calls Later
                          through a provider      

  Risk prediction         Predict danger from     Out of initial scope
                          movement patterns       
  -----------------------------------------------------------------------

## 6. User Workflow

1.  The user opens GeoPresence and grants location permission if they
    want to use device location.
2.  The user creates a journey and selects the destination and expected
    arrival time.
3.  The user chooses a trusted contact and reviews what information will
    be shared.
4.  The journey becomes active.
5.  The user confirms arrival, extends the ETA, or cancels the journey.
6.  If the ETA passes, the system enters an overdue-pending state and
    prompts the user.
7.  If the user does not respond before the grace period expires, the
    system sends the configured notification.
8.  The journey ends when the user confirms arrival or cancels it.

A missed check-in is an indication that follow-up may be useful, not
proof of an emergency.

## 7. Technology Stack

Suggested stack for the first web MVP:

  -----------------------------------------------------------------------
  Layer                   Suggested technology    Responsibility
  ----------------------- ----------------------- -----------------------
  Frontend                HTML, CSS, JavaScript   Forms, status display,
                                                  browser interactions

  Map                     Leaflet                 Interactive map,
                                                  markers, optional route
                                                  display

  Basemap                 OpenStreetMap tiles or  Map background
                          another permitted tile  
                          provider                

  Backend API             Python and FastAPI      Journey rules,
                                                  validation,
                                                  authorization, API

  Database                PostgreSQL with PostGIS Journey records and
                                                  geographic data

  Authentication          Supabase Auth or a      User identity and
                          backend-managed         access
                          authentication system   

  Notifications           Email provider for MVP  Notify trusted contacts

  Routing                 Optional                Route geometry and
                          OSRM-compatible service distance estimates

  Version control         Git and GitHub          Source control and
                                                  collaboration
  -----------------------------------------------------------------------

Choose one authentication and database approach before implementation.
If Supabase is used, configure database access policies and server-side
functions carefully; do not expose privileged service keys in browser
code.

## 8. High-Level Architecture

``` text
User's browser
  ├── Journey forms and status
  ├── Browser geolocation (permission-based)
  └── Leaflet map
          |
          | HTTPS API requests
          v
FastAPI backend
  ├── Authentication and authorization
  ├── Journey creation and updates
  ├── Check-in and ETA rules
  ├── Overdue journey processor
  └── Notification service
          |
          v
PostgreSQL + PostGIS
  ├── Users and preferences
  ├── Trusted contacts
  ├── Journeys
  ├── Check-ins
  └── Notification audit records
```

The overdue processor must run on the server or a reliable scheduled
service. It must not depend on the user's browser remaining open.

## 9. Data Requirements

GeoPresence primarily generates its own operational data. It does not
require a large external incident dataset for the MVP.

-   **Device location:** coordinates obtained only with user permission.
-   **Destination:** user-selected map point or geocoded address.
-   **Journey timestamps:** creation, expected arrival, check-in, and
    closure times.
-   **Trusted contact:** contact details and the user's authorization to
    notify them.
-   **Road network:** optional OpenStreetMap data for route display.
-   **Administrative boundaries:** optional open boundary data for
    future summaries.

Store the minimum location data necessary for the feature. Avoid
collecting continuous location history unless a clearly defined,
consent-based feature requires it.

## 10. MVP Scope

### Included

-   Create a journey.
-   Select or capture an origin.
-   Select a destination on a map.
-   Set an expected arrival time and grace period.
-   Nominate a trusted contact.
-   Confirm arrival, extend ETA, or cancel.
-   Detect overdue journeys server-side.
-   Notify the trusted contact.
-   Display journey status and the last authorized location timestamp.
-   Revoke sharing or close the journey.

### Excluded from the first release

-   Automatic police or emergency-service dispatch.
-   Claims that a person is safe based only on GPS.
-   AI-based danger prediction.
-   Continuous background tracking as a default.
-   National security incident intelligence.
-   Guaranteed SMS delivery or operation without connectivity.

## 11. Installation and Local Development

### Prerequisites


### Backend setup

``` bash
git clone <your-repository-url>
cd geopresence

python -m venv .venv
```

Activate the environment:

**Windows PowerShell**

``` powershell
.venv\Scripts\Activate.ps1
```

**macOS/Linux**

``` bash
source .venv/bin/activate
```

Install backend dependencies:

``` bash
pip install -r requirements.txt
```

Run the API and web interface:

``` bash
python -m uvicorn app.main:app --reload --host 127.0.0.1
```

Open `http://127.0.0.1:8000` for the app or
`http://127.0.0.1:8000/docs` for the API documentation. Journey data is
stored in `data/geopresence.sqlite3` by default. The browser loads Leaflet,
map tiles, and fonts from external providers, so those map assets require
internet access. Place search uses OpenStreetMap's public Nominatim service;
uncached searches are limited to one request per second and repeated queries
are cached in memory. Search is explicit, not autocomplete. Results should
be attributed to OpenStreetMap, and this public endpoint is not a production
geocoding service. New journeys require both an origin and destination. The
app requests a road route from the public OSRM demo service; if unavailable,
it labels and uses a direct-line estimate. Route matching uses local
point-to-polyline distance calculations, not PostGIS. Incident submissions
are unverified by default, expire after seven days, and are limited to ten
per client address per hour. A missing match never means the route is safe.
Live alert polling defaults to GDACS's public RSS feed for global disaster
alerts. Additional RSS/Atom feeds can be configured as a semicolon-separated
list in `NEWS_FEED_URLS`; only dated entries with embedded GeoRSS coordinates
are mapped. Feeds without coordinates are skipped, and articles older than
72 hours are ignored by default. The worker polls every 15 minutes and
deduplicates by source URL. Set `NEWS_FEED_URLS` to an empty value to disable
external feed imports. GDACS is a disaster-alert source, not a general local
news service.

### Accounts, trip sharing, and location history

Create an account or sign in before creating or viewing journeys. A journey
owner can add a participant by entering the email address on their existing
GeoPresence account. Access is granted immediately; the invited participant
will see the trip after signing in to the same app database. An open app checks
for newly shared trips every eight seconds. Trip members can read and send
messages while a journey is active. The chat refreshes about every four
seconds.

When planning a journey, choose a departure time. The app calculates the ETA
from the road-routing service's estimated driving duration, then sets an
extended time window to 20% of that duration, with a five-minute minimum and a thirty-minute
maximum. This estimate does not account for live traffic. If road routing is
unavailable, the app labels its fallback as approximate and estimates travel
at 30 km/h from the direct-line route. The ETA can still be extended after the
journey starts.

Live location sharing is opt-in for each participant and requires browser
location permission. While sharing is enabled, the app records a point at
most once every five seconds and makes the current point available to trip
members. Sharing a trip grants access to the trip, but does not automatically
turn on a participant's location sharing. Each person must select **Share my
live location** and allow the browser location prompt. A current point is
treated as stale after 60 seconds without an update. Turn sharing off to
remove the current point; recorded history remains available to trip members.
Browser location updates stop when the page closes and are not a background
mobile tracking service.

Open **Your journey**, then expand **Past journeys** to view a completed
journey's planned route, saved location points, and chat history. Select
**View saved route on map** to display the planned line and recorded location
tracks. **Export trip as KML** downloads the planned route and timestamped
location points for opening in a compatible mapping application. KML downloads
and trip history are restricted to trip participants. Location points are
recorded only from the point live sharing is enabled; earlier journeys cannot
show points the app did not store.

The default server binds to `127.0.0.1`, so another person's device cannot
reach it. For trip sharing between different devices, deploy the app at a
network address both participants can reach and use HTTPS. Do not expose this
development prototype directly to the public internet.

Run the focused backend tests with:

``` bash
python -m unittest discover -s tests -v
```

Browser geolocation is permission-based and works on localhost or HTTPS.
Travellers create an account or sign in before creating, viewing, or updating
their journeys. Passwords are stored as salted PBKDF2 hashes and the browser
keeps an opaque local session token for fourteen days. Each journey is scoped
to its owner and invited participants; legacy journeys without an owner are
not shown to signed-in travellers. Live location sharing is opt-in and works
while the browser page is open; background mobile location updates are not
included. Moderator access remains a single optional server token, not a
multi-user role system.

## 12. Configuration

Use environment variables for secrets and deployment-specific settings.
Copy `.env.example` to `.env` when configuring email delivery, moderator
access, or non-default route/report settings. Without SMTP settings, the app
records overdue events locally and sends no email.

``` dotenv
SMTP_HOST=
SMTP_PORT=587
SMTP_STARTTLS=true
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM=
GEOCODER_CONTACT=
MODERATOR_TOKEN=
ROUTE_ALERT_BUFFER_METERS=500
REPORT_EXPIRY_DAYS=7
```

Run with `python -m uvicorn app.main:app --reload --host 127.0.0.1
--env-file .env` to load local settings. Use placeholder values in example
files and never commit real credentials. Without both `SMTP_HOST` and
`SMTP_FROM`, no email is sent. `GEOCODER_CONTACT` can identify the local
application contact in its Nominatim User-Agent. Set a strong local
`MODERATOR_TOKEN` to enable hidden/expired report review, corrections, and
moderation history. Configure the token before exposing moderator controls.
Configure
`NEWS_FEED_URLS` as a semicolon-separated list of trusted RSS/Atom feeds that
include GeoRSS point coordinates to supplement/replace the default GDACS
feed. A moderator can trigger a one-off sync from the app.

## 13. Testing Scenarios

1.  **Successful arrival:** user checks in before the ETA; no overdue
    notification is sent.
2.  **ETA extension:** user extends the ETA; the old deadline no longer
    triggers an alert.
3.  **Missed check-in:** ETA passes, user is prompted, and notification
    is sent only after the grace period.
4.  **Journey cancellation:** cancelled journeys are excluded from
    overdue processing.
5.  **Duplicate processing:** repeated scheduler runs do not send
    duplicate notifications for the same overdue event.
6.  **Journey authorization:** an unrelated user cannot view a journey;
    its owner and invited participants can access the shared trip features.
7.  **Location unavailable:** user can manually enter a destination or
    proceed without GPS where appropriate.
8.  **Stale location:** the interface clearly labels the time of the
    last available location.
9.  **Notification failure:** failure is logged and handled without
    falsely displaying successful delivery.
10. **Live sharing stopped:** new location updates stop when the participant
    turns sharing off; the last current point expires while authorized trip
    history remains available to members.
11. **Place search:** a selected geocoder result sets the currently active
    origin or destination marker and persists its coordinates with the trip.
12. **Incident reporting:** community, news-linked, official, and field-team
    submissions remain unverified until a moderator changes their status.
13. **Route warnings:** visible, current reports inside the configured
    buffer are shown with source, event time, received time, distance, and
    location-accuracy context; hidden, disputed, duplicate, and expired
    reports are excluded from standard route matches.
14. **Trip collaboration:** the owner can invite an existing account; only
    the owner and invited participants can read the trip chat and location data.
15. **Live location:** a participant can start and stop location sharing;
    current points update for other participants and stale points disappear.
16. **Trip history and KML:** past journeys show their planned route, saved
    location history, and chat; KML export contains the route and timestamped
    points and rejects non-members.

## 14. Privacy and Safety

-   Request location permission only when needed and explain why it is
    required.
-   Share journey information only with contacts selected by the user.
-   Make sharing duration and revocation controls clear.
-   Use HTTPS in deployed environments.
-   Enforce authorization on the backend, not only in the frontend.
-   Minimize storage and retention of coordinates.
-   Live location history and trip chat are stored in SQLite and remain
    available to trip members; this prototype has no retention or deletion
    controls for those records.
-   Record timestamps and distinguish live location from last-known
    location.
-   Do not expose precise location through public, guessable links.
-   Protect contact information and notification credentials.
-   Define a data deletion and retention policy before public
    deployment.
-   Clearly state that the app is not an emergency dispatch service.
-   Test abuse scenarios, including unwanted tracking and attempts to
    access another person's journey.

## 15. Limitations

-   GPS can be inaccurate, unavailable, or spoofed.
-   Mobile browsers may restrict background location updates.
-   Network or power loss can prevent timely check-ins and
    notifications.
-   A contact may not read a notification.
-   A missed check-in may have an ordinary explanation.
-   Open map and routing services may have usage limits and attribution
    requirements.
-   Trip participants are added immediately by account email; invitation
    acceptance and participant removal are not implemented.
-   Location history is collected only while a participant has explicitly
    enabled live sharing in an open browser page. It does not provide
    background tracking.
-   Chat and location history currently have no automatic expiry or user
    deletion controls.

The system should communicate uncertainty instead of treating location
or timing signals as definitive evidence of danger.

## 16. Future Enhancements

-   Progressive Web App (PWA) support.
-   Optional SMS notifications.
-   More than one trusted contact.
-   Organization and field-team accounts.
-   Offline check-in queueing.
-   Background location sharing with explicit mobile permission and controls.
-   Aggregated, privacy-preserving spatial summaries.
-   Validated route and accessibility enhancements.
-   Partnerships with organizations that can define safe, realistic
    response procedures.

## 17. Contribution and License

During development, use feature branches, document setup changes, add
tests for journey-state rules, and review privacy implications before
introducing new location features.

Add a license before distributing the project publicly. Until a license
is selected, reuse and redistribution terms should be treated as
unspecified.
