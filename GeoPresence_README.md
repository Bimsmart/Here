# GeoPresence

**A geospatial safety and field-accountability platform for journey check-ins, route-based threat awareness, and trusted-contact notifications.**

GeoPresence helps individuals and field teams plan journeys, check in at expected points, notify trusted contacts when check-ins are missed, and review reports of possible threats near their routes.

> **Project status:** Proposed MVP specification. These documents describe planned functionality, not an implemented or deployed service.

## 1. Problem Statement

Travellers and field teams may lack a simple way to confirm progress along a journey and understand reported incidents that could affect their route. Journey-sharing tools generally focus on location sharing, while community or news reports may be difficult to connect to a specific planned journey. GeoPresence proposes a single geospatial workflow for journey accountability and transparent, source-attributed route warnings.

## 2. Proposed Solution

GeoPresence combines:
- Planned journeys, destinations, expected arrival times, and manual check-ins.
- Trusted-contact notifications when a check-in remains overdue.
- Map-based reporting of possible incidents and hazards.
- Community submissions, links to news reports, and official alerts where accessible.
- Route-proximity warnings that show source, timestamp, and verification status.
- A future organisation dashboard for coordinating field teams and reviewing route-related reports.

The guiding question is **“Are you there?”** The wider platform also asks: **“What has been reported along the way?”**

## 3. Target Users

- Individuals, commuters, and students.
- Surveyors, technicians, delivery personnel, and other field workers.
- Organisations coordinating field teams.
- Trusted contacts and authorised report moderators.

The first MVP should prioritise a reliable journey flow plus a basic incident-reporting and route-warning workflow.

## 4. Core Features

| Feature | Description | MVP |
|---|---|---|
| Journey creation | Origin, destination, route, ETA, grace period | Yes |
| Trusted contact | User chooses who receives journey updates | Yes |
| Check-in | User confirms arrival or checkpoint progress | Yes |
| Overdue processing | Server checks missed ETA and applies grace period | Yes |
| Incident submission | Category, description, location, reported time, source | Yes |
| News evidence | Attach a news article URL to a report | Yes |
| Route proximity | Find reports within a configurable buffer around a route | Yes |
| Verification status | Unverified, under review, corroborated, confirmed, disputed, expired | Yes |
| Moderation | Review, hide, correct, merge duplicates, expire reports | Basic |
| Automated news ingestion | Import and geolocate news automatically | Later |
| Risk prediction | Predict danger using AI or historical patterns | Out of initial scope |

## 5. User Workflow

### Journey workflow
1. User creates a journey and selects a destination.
2. User sets an expected arrival time and selects a trusted contact.
3. GeoPresence displays the planned route and relevant available reports.
4. User checks in at a checkpoint, extends the ETA, arrives, or cancels.
5. If the ETA passes, the system prompts the user and applies a configured grace period.
6. If no check-in occurs, the system notifies the authorised contact according to the journey rules.

### Threat-report workflow
1. A user submits a community report, or a report is added with a news link or official source.
2. The report is assigned a location, reported time, source type, and verification status.
3. A moderator reviews it when needed; duplicates and stale reports are handled.
4. GeoPresence queries visible, current reports near the planned route.
5. The user sees a warning with its source, date, approximate location, and verification status.

A missed check-in is not proof of danger. A nearby report is not proof that an area is currently dangerous. No matching reports does not mean a route is safe.

## 6. Threat Report Data

Every report should retain, where available:
- Incident category and neutral description.
- Point location or affected area and location accuracy.
- Time the incident reportedly occurred and time GeoPresence received it.
- Source type: `community`, `news`, `official`, or `field_team`.
- Original source URL or protected reporter reference.
- Verification status and moderation history.
- Last reviewed time and expiry/review deadline.

Example categories include reported robbery, assault, road blockage, civil unrest, flooding, fire, and infrastructure disruption. Categories must be configurable and must not imply verification.

## 7. Technology Stack

| Layer | Suggested technology | Purpose |
|---|---|---|
| Frontend | HTML, CSS, JavaScript | Forms, journey status, reports |
| Map | Leaflet | Routes, checkpoints, incident markers |
| Basemap | OpenStreetMap-compatible provider | Geographic context |
| Backend | Python + FastAPI | Validation, authorisation, business rules |
| Database | PostgreSQL + PostGIS | Journey data and spatial queries |
| Authentication | Supabase Auth or secure backend-managed authentication | User identity and access |
| Notifications | Email provider for MVP | Journey and route alerts |
| Routing | Optional OSRM-compatible service | Route geometry |
| Version control | Git | Source control |

Keep privileged keys on the server. If Supabase is selected, configure row-level security and server-side operations carefully.

## 8. High-Level Architecture

```text
Browser / Web UI
  ├── Journey and check-in screens
  ├── Leaflet map and route display
  └── Incident submission and report feed
          |
          v
FastAPI backend
  ├── Authentication and authorisation
  ├── Journey and check-in service
  ├── Incident reporting service
  ├── Route proximity query
  ├── Moderation and expiry processing
  └── Notification service
          |
          v
PostgreSQL + PostGIS
  ├── Users and trusted contacts
  ├── Journeys and check-ins
  ├── Incident reports and moderation history
  └── Notification audit records
```

## 9. MVP Scope

### Included
- Journey creation, ETA, check-in, cancellation, and trusted-contact notification.
- Destination or route display.
- Manual incident reports and news URLs.
- Incident location, source, reported time, and verification status.
- PostGIS query for reports near a planned route.
- Basic report review and expiry.
- Clear labels for unverified reports and uncertain locations.

### Excluded initially
- Automatic police or emergency-service dispatch.
- Guaranteed safety scores or predictive crime claims.
- Automated scraping of all news sources.
- Automatic rerouting without user review.
- Default continuous background tracking.
- Guaranteed notification delivery or offline real-time alerts.

## 10. Installation and Local Development

These are suggested steps for a future implementation; confirm the actual repository structure before running them.

Prerequisites: Python 3.11+, PostgreSQL with PostGIS or a configured hosted database, and Git.

```bash
git clone <your-repository-url>
cd geopresence
python -m venv .venv
```

Activate the environment:

```bash
# Windows PowerShell
.venv\Scripts\Activate.ps1

# macOS/Linux
source .venv/bin/activate
```

After defining `requirements.txt`, install dependencies and run the API if the entry point is `app.main:app`:

```bash
pip install -r requirements.txt
uvicorn app.main:app --reload
```

FastAPI documentation is typically available at `http://127.0.0.1:8000/docs`.

## 11. Configuration

A future `.env.example` could include:

```dotenv
APP_ENV=development
DATABASE_URL=postgresql://user:password@localhost:5432/geopresence
FRONTEND_ORIGIN=http://localhost:5500
DEFAULT_GRACE_PERIOD_MINUTES=10
ROUTE_ALERT_BUFFER_METRES=500
NOTIFICATION_PROVIDER=console
```

These are placeholders. Never commit real credentials or expose privileged service keys in browser code.

## 12. Testing Scenarios

1. A timely check-in does not trigger an overdue notification.
2. Extending an ETA updates the overdue deadline.
3. Cancelled journeys are excluded from overdue processing.
4. A report inside the configured route buffer appears; one outside it does not.
5. Expired, hidden, or disputed reports do not trigger standard alerts.
6. An old news story keeps its original incident date even if recently submitted.
7. A report with uncertain location is labelled approximate or excluded from proximity matching.
8. Duplicate reports do not create repeated notifications.
9. Ordinary users cannot change verification status or access private reporter details.
10. A route with no matching reports says “No matching reports found,” not “Safe.”
11. Notification failures are logged without falsely claiming successful delivery.

## 13. Privacy, Safety, and Moderation

- Request location permission only when required and explain why.
- Share journeys only with user-authorised contacts.
- Enforce access controls on the backend.
- Minimise storage and retention of precise coordinates.
- Keep reporter identity and exact reporting location private by default.
- Validate source URLs and escape user-submitted text.
- Provide correction and dispute mechanisms.
- Keep an audit trail of moderation actions.
- Avoid publishing unsupported allegations or identifying alleged suspects.
- Expire or clearly label stale reports.
- Rate-limit reports to reduce spam and coordinated abuse.
- Do not treat missing reports as proof of safety.
- State clearly that GeoPresence is not an emergency dispatch service.

## 14. Limitations

GPS may be inaccurate or unavailable; news reports can be old or mislocated; community reports can be mistaken or malicious; routes and notifications depend on third-party services and connectivity. GeoPresence should communicate uncertainty and source context instead of presenting an unverified report as fact.

## 15. Roadmap

**Phase 1:** Journey creation, manual check-ins, trusted contacts, and overdue notifications.

**Phase 2:** Manual incident reporting, news links, moderation, and route-proximity alerts.

**Phase 3:** Organisation and field-team dashboard, checkpoint monitoring, and configurable alert subscriptions.

**Phase 4:** Carefully evaluated news ingestion, geocoding, duplicate detection, and privacy-preserving spatial summaries.

## 16. Contribution and License

Use Git issues and pull requests to document changes, tests, and design decisions. Add a license before public distribution. This document is a proposed specification, not a statement that features have already been implemented.
