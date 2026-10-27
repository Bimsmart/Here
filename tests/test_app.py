import json
import tempfile
import unittest
from contextlib import closing
from datetime import timedelta
from email.utils import format_datetime
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

from app import main


class OverdueWorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        database = Path(self.temp_dir.name) / "test.sqlite3"
        self.database_patch = patch.object(main, "DATABASE_PATH", database)
        self.database_patch.start()
        main.init_db()
        self.journey_id = "journey-test"
        now = main.utc_now()
        eta = main.timestamp(now - timedelta(minutes=20))
        with closing(main.connect_db()) as connection:
            connection.execute(
                """INSERT INTO journeys (
                    id, destination_lat, destination_lon, destination_label, eta,
                    grace_period_seconds, contact_name, contact_email, status,
                    created_at, updated_at
                ) VALUES (?, 6.52, 3.38, 'Test destination', ?, 600,
                          'Trusted person', 'trusted@example.com', 'ACTIVE', ?, ?)""",
                (self.journey_id, eta, main.timestamp(now), main.timestamp(now)),
            )
            connection.commit()

    def tearDown(self):
        self.database_patch.stop()
        self.temp_dir.cleanup()

    def test_overdue_journey_creates_one_local_log_event(self):
        main.process_overdue_once()
        main.process_overdue_once()
        with closing(main.connect_db()) as connection:
            journey = connection.execute(
                "SELECT status FROM journeys WHERE id = ?", (self.journey_id,)
            ).fetchone()
            events = connection.execute(
                "SELECT status FROM notification_events WHERE journey_id = ?", (self.journey_id,)
            ).fetchall()
        self.assertEqual(journey["status"], "OVERDUE_PENDING")
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["status"], "LOGGED")

    def test_cancelled_journey_does_not_notify(self):
        with closing(main.connect_db()) as connection:
            connection.execute(
                "UPDATE journeys SET status = 'CANCELLED' WHERE id = ?", (self.journey_id,)
            )
            connection.commit()
        main.process_overdue_once()
        with closing(main.connect_db()) as connection:
            count = connection.execute("SELECT COUNT(*) FROM notification_events").fetchone()[0]
        self.assertEqual(count, 0)

    def test_eta_extension_cancels_a_queued_old_deadline(self):
        with closing(main.connect_db()) as connection:
            journey = connection.execute(
                "SELECT eta FROM journeys WHERE id = ?", (self.journey_id,)
            ).fetchone()
            connection.execute(
                """INSERT INTO notification_events
                   (id, journey_id, idempotency_key, status, created_at, next_attempt_at)
                   VALUES ('event-old', ?, ?, 'PENDING', ?, ?)""",
                (
                    self.journey_id,
                    f"{self.journey_id}:{journey['eta']}",
                    main.timestamp(),
                    main.timestamp(),
                ),
            )
            connection.execute(
                "UPDATE journeys SET eta = ?, status = 'ACTIVE' WHERE id = ?",
                (main.timestamp(main.utc_now() + timedelta(minutes=20)), self.journey_id),
            )
            connection.commit()

        main.process_overdue_once()

        with closing(main.connect_db()) as connection:
            event = connection.execute(
                "SELECT status FROM notification_events WHERE id = 'event-old'"
            ).fetchone()
        self.assertEqual(event["status"], "CANCELLED")


class PlaceSearchTests(unittest.TestCase):
    def test_search_parses_coordinates_and_caches_normalized_query(self):
        cache_key = "geo presence test place"
        main.GEOCODE_CACHE.pop(cache_key, None)
        payload = [{
            "display_name": "Test Place, Example",
            "lat": "12.34",
            "lon": "56.78",
            "type": "city",
        }]
        response = BytesIO(json.dumps(payload).encode())
        with patch.object(main, "urlopen", return_value=response) as geocoder:
            first = main.search_places("Geo Presence Test Place")
            second = main.search_places("  GEO   PRESENCE TEST PLACE ")

        self.assertEqual(first, second)
        self.assertEqual(first[0]["latitude"], 12.34)
        self.assertEqual(first[0]["longitude"], 56.78)
        geocoder.assert_called_once()


class NewsFeedParserTests(unittest.TestCase):
    def test_rss_georss_parsing_separates_publication_from_event_time(self):
        feed = b"""<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0" xmlns:georss="http://www.georss.org/georss">
          <channel>
            <title>Lagos Live News</title>
            <item>
              <title>Flooding reported near Island road</title>
              <link>https://news.example.test/flooding</link>
              <pubDate>Wed, 14 Oct 2026 12:00:00 GMT</pubDate>
              <georss:point>6.5244 3.3792</georss:point>
            </item>
            <item>
              <title>Unlocated article is skipped</title>
              <link>https://news.example.test/unlocated</link>
              <pubDate>Wed, 14 Oct 2026 12:05:00 GMT</pubDate>
            </item>
          </channel>
        </rss>"""

        feed_title, entries = main.parse_live_feed(feed)

        self.assertEqual(feed_title, "Lagos Live News")
        self.assertEqual(len(entries), 2)
        self.assertEqual(entries[0]["coordinates"], (6.5244, 3.3792))
        self.assertEqual(entries[0]["source_published_at"], "2026-10-14T12:00:00Z")
        self.assertIsNone(entries[0]["reported_at"])
        self.assertIsNone(entries[1]["coordinates"])


class NewsFeedSyncTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database_patch = patch.object(
            main, "DATABASE_PATH", Path(self.temp_dir.name) / "news-sync.sqlite3"
        )
        self.database_patch.start()
        main.init_db()

    def tearDown(self):
        self.database_patch.stop()
        self.temp_dir.cleanup()

    def test_live_sync_imports_only_fresh_geolocated_articles_once(self):
        published = format_datetime(main.utc_now() - timedelta(minutes=20), usegmt=True)
        expected_publication = main.parse_feed_datetime(published)
        stale = format_datetime(main.utc_now() - timedelta(days=5), usegmt=True)
        feed = f"""<?xml version="1.0"?>
        <rss version="2.0" xmlns:georss="http://www.georss.org/georss">
          <channel><title>Live Lagos News</title>
            <item><title>Flooding reported by live feed</title><link>https://news.example.test/live-flood</link><pubDate>{published}</pubDate><georss:point>6.5244 3.3792</georss:point></item>
            <item><title>Old flood story</title><link>https://news.example.test/old-flood</link><pubDate>{stale}</pubDate><georss:point>6.52 3.38</georss:point></item>
            <item><title>Unlocated current story</title><link>https://news.example.test/no-place</link><pubDate>{published}</pubDate></item>
          </channel>
        </rss>""".encode()

        with patch.dict("os.environ", {"NEWS_FEED_URLS": "https://news.example.test/feed.xml"}):
            with patch.object(main, "urlopen", side_effect=lambda *args, **kwargs: BytesIO(feed)):
                first_sync = main.sync_news_feeds_once(force=True)
                second_sync = main.sync_news_feeds_once(force=True)

        with closing(main.connect_db()) as connection:
            rows = connection.execute("SELECT * FROM incident_reports").fetchall()
        self.assertEqual(first_sync["last_added"], 1)
        self.assertEqual(first_sync["last_skipped"], 2)
        self.assertEqual(second_sync["last_added"], 0)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["source_type"], "news")
        self.assertEqual(rows[0]["verification_status"], "unverified")
        self.assertEqual(rows[0]["source_published_at"], expected_publication)
        self.assertIsNone(rows[0]["reported_at"])

    def test_gdacs_is_default_and_imported_as_official(self):
        published = format_datetime(main.utc_now() - timedelta(minutes=10), usegmt=True)
        feed = f"""<rss xmlns:georss="http://www.georss.org/georss"><channel>
          <title>GDACS RSS information</title>
          <item><title>Flood alert near test location</title><link>https://www.gdacs.org/alert/1</link>
            <pubDate>{published}</pubDate><gdacs:fromdate xmlns:gdacs="http://www.gdacs.org">{published}</gdacs:fromdate>
            <georss:point>6.5244 3.3792</georss:point></item>
        </channel></rss>""".encode()
        with patch.dict("os.environ", {}, clear=True):
            self.assertEqual(main.configured_news_feeds(), ["https://www.gdacs.org/xml/rss.xml"])
            with patch.object(main, "urlopen", return_value=BytesIO(feed)):
                status = main.sync_news_feeds_once(force=True)

        with closing(main.connect_db()) as connection:
            report = connection.execute("SELECT * FROM incident_reports").fetchone()
        self.assertEqual(status["last_added"], 1)
        self.assertEqual(report["source_type"], "official")
        self.assertEqual(report["reported_at"], main.parse_feed_datetime(published))


class IncidentReportTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database_patch = patch.object(
            main, "DATABASE_PATH", Path(self.temp_dir.name) / "incidents.sqlite3"
        )
        self.database_patch.start()
        main.init_db()

    def tearDown(self):
        self.database_patch.stop()
        self.temp_dir.cleanup()

    def create_report(self, **overrides):
        values = {
            "title": "Road blockage reported",
            "description": "A community member reported a road obstruction.",
            "category": "road_blockage",
            "source_type": "community",
            "location": {"latitude": 0.001, "longitude": 0.01, "accuracy_m": 80},
        }
        values.update(overrides)
        test_request = SimpleNamespace(client=SimpleNamespace(host=f"test-{id(self)}"))
        return main.create_incident(main.IncidentCreate(**values), test_request)

    def insert_route_journey(self, journey_id="route-test"):
        now = main.timestamp()
        with closing(main.connect_db()) as connection:
            connection.execute(
                """INSERT INTO journeys (
                    id, origin_lat, origin_lon, route_coordinates, route_source,
                    destination_lat, destination_lon, destination_label, eta,
                    grace_period_seconds, contact_name, contact_email, status,
                    created_at, updated_at
                ) VALUES (?, 0, 0, ?, 'osrm', 0, 0.02, 'Route test', ?, 600,
                          'Contact', 'contact@example.test', 'ACTIVE', ?, ?)""",
                (
                    journey_id,
                    json.dumps([[0, 0], [0.02, 0]]),
                    main.timestamp(main.utc_now() + timedelta(hours=1)),
                    now,
                    now,
                ),
            )
            connection.commit()
        return journey_id

    def insert_report_row(self, report_id, latitude, longitude, status="unverified", visible=1, expires_at=None):
        now = main.timestamp()
        with closing(main.connect_db()) as connection:
            connection.execute(
                """INSERT INTO incident_reports (
                    id, title, description, category, source_type, reported_at, received_at,
                    latitude, longitude, verification_status, expires_at, is_visible
                ) VALUES (?, ?, ?, 'road_blockage', 'community', ?, ?, ?, ?, ?, ?, ?)""",
                (
                    report_id,
                    report_id,
                    "A test incident report with enough detail.",
                    now,
                    now,
                    latitude,
                    longitude,
                    status,
                    expires_at or main.timestamp(main.utc_now() + timedelta(days=2)),
                    visible,
                ),
            )
            connection.commit()

    def test_new_report_is_unverified_and_separates_event_and_received_times(self):
        event_time = main.utc_now() - timedelta(hours=2)
        report = self.create_report(reported_at=event_time)
        self.assertEqual(report["verification_status"], "unverified")
        self.assertNotEqual(report["reported_at"], report["received_at"])
        self.assertNotIn("created_by", report)

    def test_news_report_requires_http_source_url(self):
        with self.assertRaises(ValueError):
            main.IncidentCreate(
                title="News report",
                description="A linked report with enough context.",
                category="road_blockage",
                source_type="news",
                location={"latitude": 0, "longitude": 0},
            )
        with self.assertRaises(ValueError):
            main.IncidentCreate(
                title="News report",
                description="A linked report with enough context.",
                category="road_blockage",
                source_type="news",
                source_url="javascript:alert(1)",
                location={"latitude": 0, "longitude": 0},
            )

    def test_journey_creation_requires_origin_for_route_alerts(self):
        with self.assertRaises(ValueError):
            main.JourneyCreate(
                destination={"latitude": 6.5, "longitude": 3.3},
                eta=main.utc_now() + timedelta(hours=1),
                contact_name="Contact",
                contact_email="contact@example.test",
            )

    def test_report_submission_limit_returns_429(self):
        client_key = f"rate-limit-test-{id(self)}"
        main.REPORT_RATE_BUCKETS.pop(client_key, None)
        with patch.object(main, "REPORT_RATE_LIMIT_PER_HOUR", 1):
            main.enforce_report_rate_limit(client_key)
            with self.assertRaises(HTTPException) as limited:
                main.enforce_report_rate_limit(client_key)
        self.assertEqual(limited.exception.status_code, 429)
        main.REPORT_RATE_BUCKETS.pop(client_key, None)

    def test_duplicate_detection_only_suggests_possible_match(self):
        first = self.create_report()
        second = self.create_report(title="Another road blockage")
        self.assertEqual(first["possible_duplicate_ids"], [])
        self.assertEqual(second["possible_duplicate_ids"], [first["id"]])
        self.assertEqual(second["verification_status"], "unverified")

    def test_moderation_requires_token_and_records_audit(self):
        report = self.create_report()
        with patch.dict("os.environ", {"MODERATOR_TOKEN": "test-moderator-key"}):
            with self.assertRaises(HTTPException) as unauthorized:
                main.moderate_incident(
                    report["id"],
                    main.IncidentModerationUpdate(verification_status="under_review"),
                    "Bearer wrong-key",
                )
            self.assertEqual(unauthorized.exception.status_code, 401)

            updated = main.moderate_incident(
                report["id"],
                main.IncidentModerationUpdate(verification_status="confirmed"),
                "Bearer test-moderator-key",
            )
            history = main.incident_history(report["id"], "Bearer test-moderator-key")
        self.assertEqual(updated["verification_status"], "confirmed")
        self.assertEqual(history[0]["action"], "status")
        self.assertEqual(history[0]["to_status"], "confirmed")

    def test_moderator_correction_persists_and_audits_field_changes(self):
        report = self.create_report()
        with patch.dict("os.environ", {"MODERATOR_TOKEN": "test-moderator-key"}):
            corrected = main.moderate_incident(
                report["id"],
                main.IncidentModerationUpdate(
                    title="Corrected road blockage",
                    reported_at=main.utc_now() - timedelta(hours=1),
                    latitude=0.002,
                    longitude=0.012,
                ),
                "Bearer test-moderator-key",
            )
            history = main.incident_history(report["id"], "Bearer test-moderator-key")

        self.assertEqual(corrected["title"], "Corrected road blockage")
        self.assertEqual(corrected["latitude"], 0.002)
        self.assertEqual(history[0]["action"], "correction")
        changes = json.loads(history[0]["changes_json"])
        self.assertEqual(changes["title"]["from"], "Road blockage reported")
        self.assertEqual(changes["latitude"]["to"], 0.002)

    def test_route_proximity_excludes_hidden_disputed_and_expired_reports(self):
        journey_id = self.insert_route_journey()
        self.insert_report_row("nearby", 0.001, 0.01)
        self.insert_report_row("far-away", 0.05, 0.01)
        self.insert_report_row("disputed", 0.001, 0.011, status="disputed")
        self.insert_report_row("hidden", 0.001, 0.012, visible=0)
        self.insert_report_row(
            "expired", 0.001, 0.013,
            expires_at=main.timestamp(main.utc_now() - timedelta(minutes=1)),
        )

        reports = main.route_threats(journey_id, 500)

        self.assertEqual([report["id"] for report in reports], ["nearby"])
        self.assertGreater(reports[0]["distance_to_route_m"], 0)
        self.assertLess(reports[0]["distance_to_route_m"], 200)

    def test_merging_duplicate_hides_it_and_keeps_only_canonical_route_match(self):
        journey_id = self.insert_route_journey()
        original = self.create_report(title="Canonical blockage")
        duplicate = self.create_report(title="Duplicate blockage")
        with patch.dict("os.environ", {"MODERATOR_TOKEN": "test-moderator-key"}):
            with self.assertRaises(HTTPException) as unauthorized:
                main.list_incidents_for_moderation(None)
            self.assertEqual(unauthorized.exception.status_code, 401)
            merged = main.moderate_incident(
                duplicate["id"],
                main.IncidentModerationUpdate(duplicate_of=original["id"]),
                "Bearer test-moderator-key",
            )
            moderator_reports = main.list_incidents_for_moderation("Bearer test-moderator-key")
        matches = main.route_threats(journey_id, 500)
        self.assertFalse(merged["is_visible"])
        self.assertIn(duplicate["id"], [report["id"] for report in moderator_reports])
        self.assertEqual([report["id"] for report in matches], [original["id"]])

    def test_expiry_worker_marks_stale_reports_expired(self):
        self.insert_report_row(
            "stale", 0, 0,
            expires_at=main.timestamp(main.utc_now() - timedelta(minutes=1)),
        )
        main.expire_incidents_once()
        with closing(main.connect_db()) as connection:
            status = connection.execute(
                "SELECT verification_status FROM incident_reports WHERE id = 'stale'"
            ).fetchone()["verification_status"]
        with patch.dict("os.environ", {"MODERATOR_TOKEN": "test-moderator-key"}):
            history = main.incident_history("stale", "Bearer test-moderator-key")
        self.assertEqual(status, "expired")
        self.assertEqual(history[0]["action"], "automatic_expiry")


class AuthenticationTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database_patch = patch.object(
            main, "DATABASE_PATH", Path(self.temp_dir.name) / "accounts.sqlite3"
        )
        self.database_patch.start()
        main.init_db()

    def tearDown(self):
        self.database_patch.stop()
        self.temp_dir.cleanup()

    def sign_up(self, email="traveller@example.test"):
        return main.sign_up(main.UserSignUp(
            display_name="Test Traveller", email=email, password="long-enough-password"
        ))

    def test_signup_login_and_current_user_do_not_expose_password_data(self):
        created = self.sign_up()
        user = main.current_user(f"Bearer {created['token']}")
        logged_in = main.login(main.UserLogin(
            email="traveller@example.test", password="long-enough-password"
        ))

        self.assertEqual(user["email"], "traveller@example.test")
        self.assertEqual(logged_in["user"]["id"], created["user"]["id"])
        self.assertNotIn("password_hash", user)
        with self.assertRaises(HTTPException) as invalid_login:
            main.login(main.UserLogin(email="traveller@example.test", password="not-the-password"))
        self.assertEqual(invalid_login.exception.status_code, 401)

    def test_journeys_are_limited_to_the_session_owner(self):
        owner = self.sign_up()
        other = self.sign_up("other@example.test")
        now = main.timestamp()
        with closing(main.connect_db()) as connection:
            connection.execute(
                """INSERT INTO journeys (
                    id, owner_user_id, destination_lat, destination_lon, destination_label,
                    eta, grace_period_seconds, contact_name, contact_email, status, created_at, updated_at
                ) VALUES ('private-journey', ?, 6.52, 3.38, 'Private destination', ?, 600,
                          'Trusted contact', 'trusted@example.test', 'ACTIVE', ?, ?)""",
                (owner["user"]["id"], main.timestamp(main.utc_now() + timedelta(hours=1)), now, now),
            )
            connection.commit()

        owner_journeys = main.list_journeys(f"Bearer {owner['token']}")
        other_journeys = main.list_journeys(f"Bearer {other['token']}")

        self.assertEqual([journey["id"] for journey in owner_journeys], ["private-journey"])
        self.assertEqual(other_journeys, [])
        with self.assertRaises(HTTPException) as forbidden:
            main.read_journey("private-journey", f"Bearer {other['token']}")
        self.assertEqual(forbidden.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
