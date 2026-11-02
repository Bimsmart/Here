from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
import re
import secrets
import smtplib
import sqlite3
import time
import xml.etree.ElementTree as ET
from contextlib import closing
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.utils import parsedate_to_datetime
from pathlib import Path
from threading import Lock
from typing import Literal
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen
from uuid import uuid4

from fastapi import FastAPI, Header, HTTPException, Query, Request as FastAPIRequest, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator, model_validator

try:
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # SQLite remains available for local development installs.
    psycopg = None
    dict_row = None


ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = ROOT / "static"
DATABASE_PATH = Path(os.getenv("GEOPRESENCE_DATABASE", ROOT / "data" / "geopresence.sqlite3"))
DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
WORKER_INTERVAL_SECONDS = 10
NEWS_SYNC_INTERVAL_SECONDS = 900
MAX_NEWS_FEEDS = 10
MAX_ITEMS_PER_FEED = 25
MAX_FEED_BYTES = 2_000_000
MAX_NEWS_AGE_HOURS = 72
DEFAULT_NEWS_FEEDS = ("https://www.gdacs.org/xml/rss.xml",)
MAX_NOTIFICATION_ATTEMPTS = 3
DEFAULT_ROUTE_ALERT_BUFFER_METERS = 500
DEFAULT_REPORT_EXPIRY_DAYS = 7
REPORT_RATE_LIMIT_PER_HOUR = 10
AUTH_TOKEN_DAYS = 14
PASSWORD_HASH_ITERATIONS = 600_000
REPORT_CATEGORIES = (
    "robbery_report",
    "assault_report",
    "road_blockage",
    "civil_unrest",
    "flooding",
    "fire",
    "infrastructure_disruption",
    "other",
)
REPORT_SOURCE_TYPES = ("community", "news", "official", "field_team")
REPORT_STATUSES = ("unverified", "under_review", "corroborated", "confirmed", "disputed", "expired")
GEOCODE_CACHE: dict[str, list[dict]] = {}
GEOCODE_LOCK = Lock()
LAST_GEOCODE_REQUEST = 0.0
ROUTE_CACHE: dict[str, list[list[float]]] = {}
ROUTE_DURATION_CACHE: dict[str, int] = {}
REPORT_RATE_LOCK = Lock()
REPORT_RATE_BUCKETS: dict[str, list[float]] = {}
NEWS_SYNC_LOCK = Lock()
LAST_NEWS_SYNC_MONOTONIC = 0.0
NEWS_SYNC_STATUS = {
    "enabled": False,
    "last_sync_at": None,
    "feeds_configured": 0,
    "last_added": 0,
    "last_skipped": 0,
    "errors": [],
}


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def timestamp(value: datetime | None = None) -> str:
    return (value or utc_now()).astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def xml_local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].casefold()


def direct_child_text(element: ET.Element, names: set[str]) -> str | None:
    for child in element:
        if xml_local_name(child.tag) in names:
            value = " ".join("".join(child.itertext()).split())
            if value:
                return value
    return None


def parse_feed_datetime(value: str | None) -> str | None:
    if not value:
        return None
    try:
        parsed = parsedate_to_datetime(value)
    except (TypeError, ValueError, OverflowError):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return timestamp(parsed)


def parse_georss_coordinates(entry: ET.Element) -> tuple[float, float] | None:
    latitude = None
    longitude = None
    for element in entry.iter():
        name = xml_local_name(element.tag)
        text = (element.text or "").strip()
        if name in ("point", "pos") and text:
            parts = re.split(r"[\s,]+", text)
            if len(parts) >= 2:
                try:
                    latitude, longitude = float(parts[0]), float(parts[1])
                except ValueError:
                    continue
        elif name in ("lat", "latitude") and text:
            try:
                latitude = float(text)
            except ValueError:
                continue
        elif name in ("long", "lon", "longitude") and text:
            try:
                longitude = float(text)
            except ValueError:
                continue
    if latitude is None or longitude is None:
        return None
    if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
        return None
    return latitude, longitude


def parse_live_feed(feed_content: bytes) -> tuple[str, list[dict]]:
    if len(feed_content) > MAX_FEED_BYTES:
        raise ValueError("Feed exceeded the configured size limit")
    root = ET.fromstring(feed_content)
    feed_title = direct_child_text(root, {"title"})
    if not feed_title:
        channel = next((element for element in root.iter() if xml_local_name(element.tag) == "channel"), None)
        feed_title = direct_child_text(channel, {"title"}) if channel is not None else None
    feed_title = feed_title or "Configured news feed"
    entries = [
        element for element in root.iter()
        if xml_local_name(element.tag) in ("item", "entry")
    ][:MAX_ITEMS_PER_FEED]
    parsed_entries = []
    for entry in entries:
        title = direct_child_text(entry, {"title"})
        link = None
        for child in entry:
            if xml_local_name(child.tag) != "link":
                continue
            link = child.attrib.get("href") or (child.text or "").strip()
            if link and child.attrib.get("rel", "alternate") == "alternate":
                break
        if not title or not link:
            continue
        publication = direct_child_text(entry, {"pubdate", "published", "updated", "date"})
        event_time = direct_child_text(entry, {"eventtime", "incidenttime", "eventdate", "fromdate"})
        coordinates = parse_georss_coordinates(entry)
        parsed_entries.append({
            "title": title[:120],
            "url": link,
            "source_published_at": parse_feed_datetime(publication),
            "reported_at": parse_feed_datetime(event_time),
            "coordinates": coordinates,
        })
    return feed_title[:120], parsed_entries


class PostgresConnection:
    """Small DB-API adapter so the existing qmark SQL works with psycopg."""

    def __init__(self, connection):
        self.connection = connection

    def execute(self, query: str, parameters=()):
        if query.strip().upper() == "BEGIN IMMEDIATE":
            # Preserve the worker's single-claim behavior if multiple replicas run.
            return self.connection.execute("SELECT pg_advisory_xact_lock(61572026)")
        return self.connection.execute(query.replace("?", "%s"), parameters)

    def commit(self) -> None:
        self.connection.commit()

    def rollback(self) -> None:
        self.connection.rollback()

    def close(self) -> None:
        self.connection.close()


DB_INTEGRITY_ERRORS = (sqlite3.IntegrityError,) + ((psycopg.IntegrityError,) if psycopg else ())


def connect_db():
    if DATABASE_URL:
        if psycopg is None:
            raise RuntimeError("DATABASE_URL is set but psycopg is not installed; install requirements.txt")
        postgres_url = DATABASE_URL
        if postgres_url.startswith("postgres://"):
            postgres_url = "postgresql://" + postgres_url.removeprefix("postgres://")
        return PostgresConnection(psycopg.connect(
            postgres_url,
            connect_timeout=10,
            row_factory=dict_row,
        ))
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DATABASE_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def _table_columns(connection, table_name: str) -> set[str]:
    if DATABASE_URL:
        rows = connection.execute(
            "SELECT column_name AS name FROM information_schema.columns "
            "WHERE table_schema = current_schema() AND table_name = ?",
            (table_name,),
        ).fetchall()
    else:
        rows = connection.execute(f"PRAGMA table_info({table_name})").fetchall()
    return {row["name"] for row in rows}


def init_db() -> None:
    with closing(connect_db()) as connection:
        schema = (
            """
            CREATE TABLE IF NOT EXISTS journeys (
                id TEXT PRIMARY KEY,
                owner_user_id TEXT REFERENCES users(id),
                origin_lat REAL,
                origin_lon REAL,
                route_coordinates TEXT,
                route_source TEXT NOT NULL DEFAULT 'direct_estimate',
                destination_lat REAL NOT NULL,
                destination_lon REAL NOT NULL,
                destination_label TEXT NOT NULL,
                eta TEXT NOT NULL,
                grace_period_seconds INTEGER NOT NULL CHECK (grace_period_seconds >= 0),
                departure_at TEXT,
                estimated_duration_seconds INTEGER,
                contact_name TEXT NOT NULL,
                contact_email TEXT NOT NULL,
                share_token TEXT UNIQUE,
                status TEXT NOT NULL CHECK (status IN (
                    'ACTIVE', 'OVERDUE_PENDING', 'OVERDUE_NOTIFIED', 'ARRIVED', 'CANCELLED'
                )),
                location_lat REAL,
                location_lon REAL,
                location_accuracy REAL,
                location_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                arrived_at TEXT,
                cancelled_at TEXT
            );
            CREATE INDEX IF NOT EXISTS journeys_status_eta ON journeys(status, eta);
            CREATE INDEX IF NOT EXISTS journeys_owner_created ON journeys(owner_user_id, created_at DESC);

            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS auth_sessions (
                token_hash TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions(user_id);

            CREATE TABLE IF NOT EXISTS journey_members (
                journey_id TEXT NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                joined_at TEXT NOT NULL,
                PRIMARY KEY (journey_id, user_id)
            );
            CREATE TABLE IF NOT EXISTS journey_messages (
                id TEXT PRIMARY KEY,
                journey_id TEXT NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                body TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS journey_messages_order ON journey_messages(journey_id, created_at);
            CREATE TABLE IF NOT EXISTS journey_member_locations (
                journey_id TEXT NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                latitude REAL NOT NULL,
                longitude REAL NOT NULL,
                accuracy REAL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (journey_id, user_id)
            );
            CREATE TABLE IF NOT EXISTS journey_location_history (
                id TEXT PRIMARY KEY,
                journey_id TEXT NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                latitude REAL NOT NULL,
                longitude REAL NOT NULL,
                accuracy REAL,
                recorded_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS journey_location_history_order
                ON journey_location_history(journey_id, user_id, recorded_at);

            CREATE TABLE IF NOT EXISTS notification_events (
                id TEXT PRIMARY KEY,
                journey_id TEXT NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
                idempotency_key TEXT NOT NULL UNIQUE,
                status TEXT NOT NULL CHECK (status IN (
                    'PENDING', 'SENDING', 'SENT', 'LOGGED', 'FAILED', 'CANCELLED'
                )),
                attempt_count INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                next_attempt_at TEXT NOT NULL,
                last_attempt_at TEXT,
                sent_at TEXT,
                last_error TEXT
            );
            CREATE INDEX IF NOT EXISTS notifications_due ON notification_events(status, next_attempt_at);

            CREATE TABLE IF NOT EXISTS incident_reports (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                description TEXT NOT NULL,
                category TEXT NOT NULL,
                source_type TEXT NOT NULL,
                source_url TEXT,
                reported_at TEXT,
                source_published_at TEXT,
                received_at TEXT NOT NULL,
                latitude REAL NOT NULL,
                longitude REAL NOT NULL,
                location_accuracy_m INTEGER,
                verification_status TEXT NOT NULL DEFAULT 'unverified',
                reviewed_by TEXT,
                reviewed_at TEXT,
                expires_at TEXT NOT NULL,
                is_visible INTEGER NOT NULL DEFAULT 1,
                duplicate_of TEXT REFERENCES incident_reports(id),
                created_by TEXT,
                CHECK (category IN ('robbery_report', 'assault_report', 'road_blockage', 'civil_unrest', 'flooding', 'fire', 'infrastructure_disruption', 'other')),
                CHECK (source_type IN ('community', 'news', 'official', 'field_team')),
                CHECK (verification_status IN ('unverified', 'under_review', 'corroborated', 'confirmed', 'disputed', 'expired'))
            );
            CREATE INDEX IF NOT EXISTS incident_reports_location ON incident_reports(latitude, longitude);
            CREATE INDEX IF NOT EXISTS incident_reports_alerts ON incident_reports(is_visible, verification_status, expires_at);

            CREATE TABLE IF NOT EXISTS moderation_events (
                id TEXT PRIMARY KEY,
                incident_id TEXT NOT NULL REFERENCES incident_reports(id) ON DELETE CASCADE,
                action TEXT NOT NULL,
                from_status TEXT,
                to_status TEXT,
                from_visible INTEGER,
                to_visible INTEGER,
                duplicate_of TEXT,
                actor TEXT NOT NULL,
                created_at TEXT NOT NULL,
                changes_json TEXT NOT NULL DEFAULT '{}'
            );
            """
        )
        if DATABASE_URL:
            # PostgreSQL requires referenced tables to exist before their FK is declared.
            connection.execute(
                """CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    display_name TEXT NOT NULL,
                    email TEXT NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )"""
            )
            for statement in schema.split(";"):
                if statement.strip():
                    connection.execute(statement)
        else:
            connection.executescript(schema)
        journey_columns = _table_columns(connection, "journeys")
        if "route_coordinates" not in journey_columns:
            connection.execute("ALTER TABLE journeys ADD COLUMN route_coordinates TEXT")
        if "route_source" not in journey_columns:
            connection.execute(
                "ALTER TABLE journeys ADD COLUMN route_source TEXT NOT NULL DEFAULT 'direct_estimate'"
            )
        if "owner_user_id" not in journey_columns:
            connection.execute("ALTER TABLE journeys ADD COLUMN owner_user_id TEXT REFERENCES users(id)")
        if "share_token" not in journey_columns:
            connection.execute("ALTER TABLE journeys ADD COLUMN share_token TEXT")
        if "departure_at" not in journey_columns:
            connection.execute("ALTER TABLE journeys ADD COLUMN departure_at TEXT")
        if "estimated_duration_seconds" not in journey_columns:
            connection.execute("ALTER TABLE journeys ADD COLUMN estimated_duration_seconds INTEGER")
        connection.execute(
            "UPDATE journeys SET departure_at = created_at WHERE departure_at IS NULL"
        )
        for row in connection.execute("SELECT id FROM journeys WHERE share_token IS NULL").fetchall():
            connection.execute(
                "UPDATE journeys SET share_token = ? WHERE id = ?",
                (secrets.token_urlsafe(32), row["id"]),
            )
        connection.execute("CREATE UNIQUE INDEX IF NOT EXISTS journeys_share_token ON journeys(share_token)")
        incident_columns = _table_columns(connection, "incident_reports")
        if "source_published_at" not in incident_columns:
            connection.execute("ALTER TABLE incident_reports ADD COLUMN source_published_at TEXT")
        if "created_by" not in incident_columns:
            connection.execute("ALTER TABLE incident_reports ADD COLUMN created_by TEXT")
        connection.execute(
            """UPDATE journeys SET route_source = 'unavailable'
               WHERE route_coordinates IS NULL AND origin_lat IS NULL AND origin_lon IS NULL"""
        )
        moderation_columns = _table_columns(connection, "moderation_events")
        if "changes_json" not in moderation_columns:
            connection.execute(
                "ALTER TABLE moderation_events ADD COLUMN changes_json TEXT NOT NULL DEFAULT '{}'"
            )
        connection.execute("CREATE INDEX IF NOT EXISTS journeys_owner_created ON journeys(owner_user_id, created_at DESC)")
        connection.commit()


class Coordinate(BaseModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)


class SharedLocationLookup(BaseModel):
    share_token: str = Field(min_length=20, max_length=128)


class UserSignUp(BaseModel):
    display_name: str = Field(min_length=1, max_length=80)
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=8, max_length=256)

    @field_validator("display_name")
    @classmethod
    def trim_display_name(cls, value: str) -> str:
        return value.strip()

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        normalized = value.strip().casefold()
        if "@" not in normalized or normalized.startswith("@") or normalized.endswith("@"):
            raise ValueError("Enter a valid email address")
        return normalized


class UserLogin(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=256)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        return value.strip().casefold()


class JourneyEstimate(BaseModel):
    origin: Coordinate
    destination: Coordinate
    departure_at: datetime = Field(default_factory=utc_now)

    @field_validator("departure_at")
    @classmethod
    def departure_must_be_timezone_aware(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("Departure time must include a timezone")
        return value.astimezone(timezone.utc)


class JourneyCreate(JourneyEstimate):
    destination_label: str = Field(default="Destination", min_length=1, max_length=120)
    contact_name: str = Field(min_length=1, max_length=120)
    contact_email: str = Field(min_length=3, max_length=254)

    @field_validator("contact_email")
    @classmethod
    def contact_email_must_look_valid(cls, value: str) -> str:
        normalized = value.strip()
        if "@" not in normalized or normalized.startswith("@") or normalized.endswith("@"):
            raise ValueError("Enter a valid contact email")
        return normalized


class EtaUpdate(BaseModel):
    eta: datetime

    @field_validator("eta")
    @classmethod
    def eta_must_be_timezone_aware_and_future(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("ETA must include a timezone")
        if value <= utc_now():
            raise ValueError("ETA must be in the future")
        return value.astimezone(timezone.utc)


class LocationUpdate(BaseModel):
    location: Coordinate
    accuracy_meters: float | None = Field(default=None, ge=0, le=100_000)


class InviteParticipant(BaseModel):
    email: str = Field(min_length=3, max_length=254)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        return value.strip().casefold()


class JourneyMessage(BaseModel):
    body: str = Field(min_length=1, max_length=1000)

    @field_validator("body")
    @classmethod
    def trim_body(cls, value: str) -> str:
        return value.strip()


class IncidentLocation(Coordinate):
    accuracy_m: int | None = Field(default=None, ge=0, le=100_000)


class IncidentCreate(BaseModel):
    title: str = Field(min_length=3, max_length=120)
    description: str = Field(min_length=8, max_length=2_000)
    category: Literal[
        "robbery_report", "assault_report", "road_blockage", "civil_unrest",
        "flooding", "fire", "infrastructure_disruption", "other",
    ]
    source_type: Literal["community", "news", "official", "field_team"] = "community"
    source_url: str | None = Field(default=None, max_length=2_000)
    reported_at: datetime | None = None
    source_published_at: datetime | None = None
    location: IncidentLocation

    @field_validator("title", "description")
    @classmethod
    def trim_report_text(cls, value: str) -> str:
        return value.strip()

    @field_validator("source_url")
    @classmethod
    def source_url_must_be_http(cls, value: str | None) -> str | None:
        if value is None or not value.strip():
            return None
        normalized = value.strip()
        if urlsplit(normalized).scheme not in ("http", "https") or not urlsplit(normalized).netloc:
            raise ValueError("Source URL must use http or https")
        return normalized

    @field_validator("reported_at")
    @classmethod
    def reported_at_must_include_timezone(cls, value: datetime | None) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("Incident time must include a timezone")
        if value > utc_now() + timedelta(minutes=5):
            raise ValueError("Incident time cannot be in the future")
        return value.astimezone(timezone.utc)

    @field_validator("source_published_at")
    @classmethod
    def source_published_at_must_include_timezone(cls, value: datetime | None) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("Source publication time must include a timezone")
        if value > utc_now() + timedelta(minutes=5):
            raise ValueError("Source publication time cannot be in the future")
        return value.astimezone(timezone.utc)

    @model_validator(mode="after")
    def news_reports_require_source(self) -> IncidentCreate:
        if self.source_type == "news" and not self.source_url:
            raise ValueError("News reports require a source URL")
        return self


class IncidentModerationUpdate(BaseModel):
    verification_status: Literal[
        "unverified", "under_review", "corroborated", "confirmed", "disputed", "expired",
    ] | None = None
    is_visible: bool | None = None
    duplicate_of: str | None = None
    title: str | None = Field(default=None, min_length=3, max_length=120)
    description: str | None = Field(default=None, min_length=8, max_length=2_000)
    category: Literal[
        "robbery_report", "assault_report", "road_blockage", "civil_unrest",
        "flooding", "fire", "infrastructure_disruption", "other",
    ] | None = None
    source_type: Literal["community", "news", "official", "field_team"] | None = None
    source_url: str | None = Field(default=None, max_length=2_000)
    reported_at: datetime | None = None
    source_published_at: datetime | None = None
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    location_accuracy_m: int | None = Field(default=None, ge=0, le=100_000)

    @field_validator("title", "description")
    @classmethod
    def trim_corrected_text(cls, value: str | None) -> str | None:
        return value.strip() if value is not None else None

    @field_validator("source_url")
    @classmethod
    def corrected_source_url_must_be_http(cls, value: str | None) -> str | None:
        if value is None or not value.strip():
            return None
        normalized = value.strip()
        if urlsplit(normalized).scheme not in ("http", "https") or not urlsplit(normalized).netloc:
            raise ValueError("Source URL must use http or https")
        return normalized

    @field_validator("reported_at")
    @classmethod
    def corrected_report_time_must_be_aware(cls, value: datetime | None) -> datetime | None:
        if value is not None and (value.tzinfo is None or value.utcoffset() is None):
            raise ValueError("Incident time must include a timezone")
        return value.astimezone(timezone.utc) if value is not None else None

    @field_validator("source_published_at")
    @classmethod
    def corrected_publication_time_must_be_aware(cls, value: datetime | None) -> datetime | None:
        if value is not None and (value.tzinfo is None or value.utcoffset() is None):
            raise ValueError("Source publication time must include a timezone")
        return value.astimezone(timezone.utc) if value is not None else None

    @model_validator(mode="after")
    def require_an_update(self) -> IncidentModerationUpdate:
        if not self.model_fields_set:
            raise ValueError("At least one moderation field is required")
        for field in ("title", "description", "category", "source_type", "latitude", "longitude"):
            if field in self.model_fields_set and getattr(self, field) is None:
                raise ValueError(f"{field} cannot be cleared")
        if (self.latitude is None) != (self.longitude is None):
            raise ValueError("Corrected latitude and longitude must be provided together")
        return self


def journey_dict(row: sqlite3.Row) -> dict:
    result = dict(row)
    route_coordinates = result.pop("route_coordinates", None)
    result["route_coordinates"] = json.loads(route_coordinates) if route_coordinates else None
    return result


def get_journey(connection: sqlite3.Connection, journey_id: str) -> sqlite3.Row:
    row = connection.execute("SELECT * FROM journeys WHERE id = ?", (journey_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Journey not found")
    return row


def search_places(query: str) -> list[dict]:
    global LAST_GEOCODE_REQUEST
    normalized_query = " ".join(query.split()).casefold()
    if normalized_query in GEOCODE_CACHE:
        return GEOCODE_CACHE[normalized_query]

    with GEOCODE_LOCK:
        elapsed = time.monotonic() - LAST_GEOCODE_REQUEST
        if elapsed < 1:
            raise HTTPException(status_code=429, detail="Please wait a second before searching again.")
        LAST_GEOCODE_REQUEST = time.monotonic()

    parameters = urlencode({"q": query, "format": "jsonv2", "limit": 5, "addressdetails": 0})
    contact = os.getenv("GEOCODER_CONTACT", "local development")
    request = Request(
        f"https://nominatim.openstreetmap.org/search?{parameters}",
        headers={
            "User-Agent": f"GeoPresence/0.1 ({contact})",
            "Accept": "application/json",
            "Accept-Language": "en",
        },
    )
    try:
        with urlopen(request, timeout=8) as response:
            payload = json.loads(response.read())
    except Exception as error:
        print(f"[GeoPresence geocoder error] {type(error).__name__}: {error}")
        raise HTTPException(status_code=502, detail="Place search is unavailable. Try again shortly.") from error

    results = [
        {
            "label": place["display_name"],
            "latitude": float(place["lat"]),
            "longitude": float(place["lon"]),
            "kind": place.get("type", "place"),
        }
        for place in payload
        if place.get("display_name") and place.get("lat") and place.get("lon")
    ]
    if len(GEOCODE_CACHE) >= 100:
        GEOCODE_CACHE.pop(next(iter(GEOCODE_CACHE)))
    GEOCODE_CACHE[normalized_query] = results
    return results


def get_route_coordinates(
    origin: Coordinate | None,
    destination: Coordinate,
) -> tuple[list[list[float]] | None, str]:
    if origin is None:
        return None, "unavailable"
    cache_key = (
        f"{origin.latitude:.5f},{origin.longitude:.5f}:"
        f"{destination.latitude:.5f},{destination.longitude:.5f}"
    )
    if cache_key in ROUTE_CACHE:
        return ROUTE_CACHE[cache_key], "osrm"

    coordinates = (
        f"{origin.longitude},{origin.latitude};"
        f"{destination.longitude},{destination.latitude}"
    )
    request = Request(
        f"https://router.project-osrm.org/route/v1/driving/{coordinates}"
        "?overview=full&geometries=geojson&steps=false",
        headers={"User-Agent": "GeoPresence/0.2 (local development)"},
    )
    try:
        with urlopen(request, timeout=10) as response:
            payload = json.loads(response.read())
        route = payload["routes"][0]["geometry"]["coordinates"]
        if len(route) < 2:
            raise ValueError("Routing service returned an incomplete route")
        normalized = [[float(point[0]), float(point[1])] for point in route]
        if any(not (-180 <= lon <= 180 and -90 <= lat <= 90) for lon, lat in normalized):
            raise ValueError("Routing service returned invalid coordinates")
        if len(ROUTE_CACHE) >= 100:
            evicted_key = next(iter(ROUTE_CACHE))
            ROUTE_CACHE.pop(evicted_key)
            ROUTE_DURATION_CACHE.pop(evicted_key, None)
        ROUTE_CACHE[cache_key] = normalized
        duration = payload["routes"][0].get("duration")
        if isinstance(duration, (int, float)) and math.isfinite(duration) and duration > 0:
            ROUTE_DURATION_CACHE[cache_key] = int(round(duration))
        return normalized, "osrm"
    except Exception as error:
        print(f"[GeoPresence routing fallback] {type(error).__name__}: {error}")
        return [
            [origin.longitude, origin.latitude],
            [destination.longitude, destination.latitude],
        ], "direct_estimate"


def estimate_travel_seconds(
    origin: Coordinate,
    destination: Coordinate,
    route: list[list[float]] | None,
    route_source: str,
) -> int:
    cache_key = (
        f"{origin.latitude:.5f},{origin.longitude:.5f}:"
        f"{destination.latitude:.5f},{destination.longitude:.5f}"
    )
    if route_source == "osrm" and cache_key in ROUTE_DURATION_CACHE:
        return ROUTE_DURATION_CACHE[cache_key]
    if route and len(route) > 1:
        distance_meters = sum(
            distance_points_m(start[1], start[0], end[1], end[0])
            for start, end in zip(route, route[1:])
        )
    else:
        distance_meters = distance_points_m(
            origin.latitude, origin.longitude, destination.latitude, destination.longitude
        )
    # Fallback is a clearly labeled 30 km/h driving estimate for local development.
    return max(60, int(round(distance_meters / (30_000 / 3_600))))


def calculate_journey_schedule(
    departure_at: datetime,
    travel_seconds: int,
) -> tuple[str, int]:
    departure = max(departure_at.astimezone(timezone.utc), utc_now())
    eta = departure + timedelta(seconds=travel_seconds)
    grace_seconds = min(1_800, max(300, int(round(travel_seconds * 0.2))))
    return timestamp(eta), grace_seconds


def distance_points_m(first_lat: float, first_lon: float, second_lat: float, second_lon: float) -> float:
    earth_radius_m = 6_371_008.8
    lat_delta = math.radians(second_lat - first_lat)
    lon_delta = math.radians(second_lon - first_lon)
    haversine = (
        math.sin(lat_delta / 2) ** 2
        + math.cos(math.radians(first_lat))
        * math.cos(math.radians(second_lat))
        * math.sin(lon_delta / 2) ** 2
    )
    return 2 * earth_radius_m * math.asin(min(1, math.sqrt(haversine)))


def distance_point_to_route_m(latitude: float, longitude: float, route: list[list[float]]) -> float:
    if not route:
        return math.inf
    earth_radius_m = 6_371_008.8
    latitude_radians = math.radians(latitude)

    def local_xy(point: list[float]) -> tuple[float, float]:
        route_lon, route_lat = point
        return (
            earth_radius_m * math.radians(route_lon - longitude) * math.cos(latitude_radians),
            earth_radius_m * math.radians(route_lat - latitude),
        )

    origin = (0.0, 0.0)
    route_points = [local_xy(point) for point in route]
    if len(route_points) == 1:
        return math.hypot(*route_points[0])

    minimum_distance = math.inf
    for start, end in zip(route_points, route_points[1:]):
        dx = end[0] - start[0]
        dy = end[1] - start[1]
        segment_length_squared = dx * dx + dy * dy
        if segment_length_squared == 0:
            nearest = start
        else:
            projection = max(
                0.0,
                min(1.0, (-(start[0] - origin[0]) * dx - (start[1] - origin[1]) * dy) / segment_length_squared),
            )
            nearest = (start[0] + projection * dx, start[1] + projection * dy)
        minimum_distance = min(minimum_distance, math.hypot(*nearest))
    return minimum_distance


def incident_dict(row: sqlite3.Row) -> dict:
    report = dict(row)
    report["is_visible"] = bool(report["is_visible"])
    return report


def get_incident(connection: sqlite3.Connection, incident_id: str) -> sqlite3.Row:
    row = connection.execute(
        "SELECT * FROM incident_reports WHERE id = ?", (incident_id,)
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Incident report not found")
    return row


def require_moderator(authorization: str | None) -> str:
    expected_token = os.getenv("MODERATOR_TOKEN", "").strip()
    if not expected_token:
        raise HTTPException(status_code=503, detail="Moderation is disabled until MODERATOR_TOKEN is configured")
    supplied_token = (authorization or "").removeprefix("Bearer ").strip()
    if not secrets.compare_digest(supplied_token, expected_token):
        raise HTTPException(status_code=401, detail="Moderator access is required")
    return "local_moderator"


def password_hash(password: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("ascii"), PASSWORD_HASH_ITERATIONS
    ).hex()
    return f"pbkdf2_sha256${PASSWORD_HASH_ITERATIONS}${salt}${digest}"


def password_matches(password: str, stored_hash: str) -> bool:
    try:
        algorithm, iterations, salt, expected_digest = stored_hash.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        calculated = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), salt.encode("ascii"), int(iterations)
        ).hex()
    except (TypeError, ValueError):
        return False
    return secrets.compare_digest(calculated, expected_digest)


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def public_user(row: sqlite3.Row | dict) -> dict:
    return {"id": row["id"], "display_name": row["display_name"], "email": row["email"]}


def create_session(connection: sqlite3.Connection, user_id: str) -> tuple[str, str]:
    token = secrets.token_urlsafe(32)
    expires_at = timestamp(utc_now() + timedelta(days=AUTH_TOKEN_DAYS))
    connection.execute(
        "INSERT INTO auth_sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
        (token_digest(token), user_id, expires_at, timestamp()),
    )
    return token, expires_at


def require_user(authorization: str | None) -> sqlite3.Row:
    supplied_token = (authorization or "").removeprefix("Bearer ").strip()
    if not supplied_token:
        raise HTTPException(status_code=401, detail="Sign in to continue")
    with closing(connect_db()) as connection:
        session = connection.execute(
            """SELECT users.id, users.display_name, users.email
               FROM auth_sessions JOIN users ON users.id = auth_sessions.user_id
               WHERE auth_sessions.token_hash = ? AND auth_sessions.expires_at > ?""",
            (token_digest(supplied_token), timestamp()),
        ).fetchone()
    if session is None:
        raise HTTPException(status_code=401, detail="Your session has expired. Sign in again.")
    return session


def get_owned_journey(connection: sqlite3.Connection, journey_id: str, user_id: str) -> sqlite3.Row:
    journey = get_journey(connection, journey_id)
    if journey["owner_user_id"] != user_id:
        raise HTTPException(status_code=404, detail="Journey not found")
    return journey


def require_journey_member(connection: sqlite3.Connection, journey_id: str, user_id: str) -> sqlite3.Row:
    journey = get_journey(connection, journey_id)
    member = connection.execute(
        "SELECT 1 FROM journey_members WHERE journey_id = ? AND user_id = ?",
        (journey_id, user_id),
    ).fetchone()
    if journey["owner_user_id"] != user_id and member is None:
        raise HTTPException(status_code=404, detail="Journey not found")
    return journey


def expire_incidents_once() -> None:
    with closing(connect_db()) as connection:
        now = timestamp()
        expiring = connection.execute(
            "SELECT id, verification_status, is_visible FROM incident_reports "
            "WHERE verification_status != 'expired' AND expires_at <= ?",
            (now,),
        ).fetchall()
        for report in expiring:
            connection.execute(
                "UPDATE incident_reports SET verification_status = 'expired', reviewed_by = 'system', reviewed_at = ? WHERE id = ?",
                (now, report["id"]),
            )
            connection.execute(
                """INSERT INTO moderation_events (
                    id, incident_id, action, from_status, to_status, from_visible,
                    to_visible, duplicate_of, actor, created_at, changes_json
                ) VALUES (?, ?, 'automatic_expiry', ?, 'expired', ?, ?, NULL, 'system', ?, '{}')""",
                (
                    str(uuid4()), report["id"], report["verification_status"],
                    report["is_visible"], report["is_visible"], now,
                ),
            )
        connection.commit()


def configured_route_buffer_m() -> int:
    try:
        configured_value = int(os.getenv("ROUTE_ALERT_BUFFER_METERS", str(DEFAULT_ROUTE_ALERT_BUFFER_METERS)))
    except ValueError:
        configured_value = DEFAULT_ROUTE_ALERT_BUFFER_METERS
    return max(50, min(configured_value, 5_000))


def enforce_report_rate_limit(client_key: str) -> None:
    now = time.monotonic()
    cutoff = now - 60 * 60
    with REPORT_RATE_LOCK:
        recent_requests = [
            request_time
            for request_time in REPORT_RATE_BUCKETS.get(client_key, [])
            if request_time > cutoff
        ]
        if len(recent_requests) >= REPORT_RATE_LIMIT_PER_HOUR:
            REPORT_RATE_BUCKETS[client_key] = recent_requests
            raise HTTPException(status_code=429, detail="Report limit reached. Try again later.")
        recent_requests.append(now)
        REPORT_RATE_BUCKETS[client_key] = recent_requests


def configured_news_feeds() -> list[str]:
    configured = os.getenv("NEWS_FEED_URLS")
    if configured is None:
        return list(DEFAULT_NEWS_FEEDS)
    feeds = []
    for candidate in re.split(r"[;\r\n]+", configured):
        feed_url = candidate.strip()
        if not feed_url:
            continue
        parts = urlsplit(feed_url)
        if parts.scheme not in ("http", "https") or not parts.netloc:
            continue
        feeds.append(feed_url)
        if len(feeds) >= MAX_NEWS_FEEDS:
            break
    return feeds


def news_category(title: str) -> str:
    lowered_title = title.casefold()
    category_keywords = (
        ("flooding", ("flood", "waterlogged")),
        ("fire", ("fire", "inferno", "blaze")),
        ("road_blockage", ("road block", "blocked road", "traffic", "crash", "accident")),
        ("civil_unrest", ("protest", "riot", "clash", "unrest")),
        ("robbery_report", ("robbery", "robbed", "armed attack", "bandit")),
        ("assault_report", ("assault", "attacked", "attack")),
        ("infrastructure_disruption", ("power outage", "blackout", "pipeline", "bridge collapse")),
    )
    for category, keywords in category_keywords:
        if any(keyword in lowered_title for keyword in keywords):
            return category
    return "other"


def normalized_source_url(source_url: str) -> str:
    parts = urlsplit(source_url)
    return parts._replace(fragment="").geturl().rstrip("/")


def news_sync_interval_seconds() -> int:
    try:
        value = int(os.getenv("NEWS_SYNC_INTERVAL_SECONDS", str(NEWS_SYNC_INTERVAL_SECONDS)))
    except ValueError:
        value = NEWS_SYNC_INTERVAL_SECONDS
    return max(300, min(value, 86_400))


def sync_news_feeds_once(force: bool = False) -> dict:
    global LAST_NEWS_SYNC_MONOTONIC
    feeds = configured_news_feeds()
    if not feeds:
        NEWS_SYNC_STATUS.update({
            "enabled": False,
            "feeds_configured": 0,
            "last_added": 0,
            "last_skipped": 0,
            "errors": [],
        })
        return dict(NEWS_SYNC_STATUS)

    with NEWS_SYNC_LOCK:
        now_monotonic = time.monotonic()
        if not force and now_monotonic - LAST_NEWS_SYNC_MONOTONIC < news_sync_interval_seconds():
            return dict(NEWS_SYNC_STATUS)
        LAST_NEWS_SYNC_MONOTONIC = now_monotonic

        now = utc_now()
        max_age_hours = max(1, min(int(os.getenv("NEWS_MAX_AGE_HOURS", str(MAX_NEWS_AGE_HOURS))), 720))
        oldest_allowed = now - timedelta(hours=max_age_hours)
        added = 0
        skipped = 0
        errors = []
        for feed_url in feeds:
            host = urlsplit(feed_url).hostname or "configured feed"
            request = Request(
                feed_url,
                headers={
                    "User-Agent": "GeoPresence/0.2 (+local safety and field-accountability app)",
                    "Accept": "application/atom+xml, application/rss+xml, application/xml, text/xml",
                },
            )
            try:
                with urlopen(request, timeout=12) as response:
                    feed_content = response.read(MAX_FEED_BYTES + 1)
                feed_title, entries = parse_live_feed(feed_content)
            except Exception as error:
                skipped += 1
                errors.append(f"{host}: {type(error).__name__}")
                print(f"[GeoPresence news sync] {host}: {type(error).__name__}")
                continue

            for entry in entries:
                coordinates = entry["coordinates"]
                published_text = entry["source_published_at"]
                if coordinates is None or published_text is None:
                    skipped += 1
                    continue
                published_at = parse_timestamp(published_text)
                if published_at < oldest_allowed or published_at > now + timedelta(minutes=5):
                    skipped += 1
                    continue
                source_url = entry["url"]
                source_parts = urlsplit(source_url)
                if source_parts.scheme not in ("http", "https") or not source_parts.netloc:
                    skipped += 1
                    continue
                canonical_url = normalized_source_url(source_url)
                category = news_category(entry["title"])
                source_host = (source_parts.hostname or "").casefold()
                source_type = "official" if source_host == "gdacs.org" or source_host.endswith(".gdacs.org") else "news"
                report_id = str(uuid4())
                received_at = timestamp(now)
                description = f"Alert imported from {feed_title}. Open the linked source for the original report."
                with closing(connect_db()) as connection:
                    existing = connection.execute(
                        "SELECT id FROM incident_reports WHERE source_url = ? LIMIT 1",
                        (canonical_url,),
                    ).fetchone()
                    if existing is None:
                        connection.execute(
                            """INSERT INTO incident_reports (
                                id, title, description, category, source_type, source_url,
                                reported_at, source_published_at, received_at, latitude, longitude,
                                location_accuracy_m, verification_status, expires_at, is_visible
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 5000, 'unverified', ?, 1)""",
                            (
                                report_id,
                                entry["title"],
                                description,
                                category,
                                source_type,
                                canonical_url,
                                entry["reported_at"],
                                published_text,
                                received_at,
                                coordinates[0],
                                coordinates[1],
                                timestamp(now + timedelta(days=DEFAULT_REPORT_EXPIRY_DAYS)),
                            ),
                        )
                        connection.commit()
                        added += 1
                    else:
                        skipped += 1

        NEWS_SYNC_STATUS.update({
            "enabled": True,
            "last_sync_at": timestamp(now),
            "feeds_configured": len(feeds),
            "last_added": added,
            "last_skipped": skipped,
            "errors": errors[:10],
        })
        return dict(NEWS_SYNC_STATUS)


def route_threats(journey_id: str, buffer_m: int) -> list[dict]:
    with closing(connect_db()) as connection:
        journey = get_journey(connection, journey_id)
        route = json.loads(journey["route_coordinates"]) if journey["route_coordinates"] else None
        if not route and journey["origin_lat"] is not None and journey["origin_lon"] is not None:
            route = [
                [journey["origin_lon"], journey["origin_lat"]],
                [journey["destination_lon"], journey["destination_lat"]],
            ]
        if not route:
            return []
        rows = connection.execute(
            """SELECT * FROM incident_reports
               WHERE is_visible = 1 AND expires_at > ?
                                 AND verification_status NOT IN ('disputed', 'expired')
                                 AND duplicate_of IS NULL""",
            (timestamp(),),
        ).fetchall()

    matches = []
    for row in rows:
        distance = distance_point_to_route_m(row["latitude"], row["longitude"], route)
        if distance <= buffer_m:
            report = incident_dict(row)
            report["distance_to_route_m"] = round(distance)
            report["approximate_location"] = bool(
                report["location_accuracy_m"] and report["location_accuracy_m"] > buffer_m
            )
            matches.append(report)
    return sorted(matches, key=lambda report: (report["distance_to_route_m"], report["reported_at"] or ""))


def send_overdue_email(recipient: str, contact_name: str, journey: sqlite3.Row) -> None:
    host = os.getenv("SMTP_HOST")
    sender = os.getenv("SMTP_FROM")
    if not host or not sender:
        raise RuntimeError("SMTP is not configured")

    message = EmailMessage()
    message["Subject"] = "GeoPresence: journey check-in overdue"
    message["From"] = sender
    message["To"] = recipient
    message.set_content(
        f"Hello {contact_name},\n\n"
        f"{journey['destination_label']} has passed its expected check-in time. "
        "Please try contacting the traveller directly. A missed check-in is not proof of an emergency.\n\n"
        f"Last available location recorded: {journey['location_at'] or 'No location recorded'}\n"
        "GeoPresence is not an emergency dispatch service."
    )

    port = int(os.getenv("SMTP_PORT", "587"))
    username = os.getenv("SMTP_USER")
    password = os.getenv("SMTP_PASSWORD")
    with smtplib.SMTP(host, port, timeout=15) as server:
        if os.getenv("SMTP_STARTTLS", "true").lower() == "true":
            server.starttls()
        if username and password:
            server.login(username, password)
        server.send_message(message)


def process_overdue_once() -> None:
    now = utc_now()
    now_text = timestamp(now)
    with closing(connect_db()) as connection:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(
            "UPDATE journeys SET status = 'OVERDUE_PENDING', updated_at = ? "
            "WHERE status = 'ACTIVE' AND eta <= ?",
            (now_text, now_text),
        )
        due = connection.execute(
            "SELECT * FROM journeys WHERE status = 'OVERDUE_PENDING'"
        ).fetchall()
        for journey in due:
            deadline = parse_timestamp(journey["eta"]) + timedelta(
                seconds=journey["grace_period_seconds"]
            )
            if deadline > now:
                continue
            connection.execute(
                "INSERT INTO notification_events "
                "(id, journey_id, idempotency_key, status, created_at, next_attempt_at) "
                "VALUES (?, ?, ?, 'PENDING', ?, ?) ON CONFLICT DO NOTHING",
                (
                    str(uuid4()),
                    journey["id"],
                    f"{journey['id']}:{journey['eta']}",
                    now_text,
                    now_text,
                ),
            )
        connection.commit()

    with closing(connect_db()) as connection:
        events = connection.execute(
            "SELECT * FROM notification_events "
            "WHERE status IN ('PENDING', 'FAILED') AND attempt_count < ? AND next_attempt_at <= ?",
            (MAX_NOTIFICATION_ATTEMPTS, now_text),
        ).fetchall()

    for event in events:
        attempt_count = event["attempt_count"] + 1
        try:
            with closing(connect_db()) as connection:
                connection.execute("BEGIN IMMEDIATE")
                current_event = connection.execute(
                    "SELECT * FROM notification_events WHERE id = ?", (event["id"],)
                ).fetchone()
                journey = connection.execute(
                    "SELECT * FROM journeys WHERE id = ?", (event["journey_id"],)
                ).fetchone()
                if current_event is None or journey is None:
                    connection.rollback()
                    continue
                deadline = parse_timestamp(journey["eta"]) + timedelta(
                    seconds=journey["grace_period_seconds"]
                )
                expected_key = f"{journey['id']}:{journey['eta']}"
                if (
                    journey["status"] not in ("OVERDUE_PENDING", "OVERDUE_NOTIFIED")
                    or deadline > utc_now()
                    or current_event["idempotency_key"] != expected_key
                ):
                    connection.execute(
                        "UPDATE notification_events SET status = 'CANCELLED' WHERE id = ?",
                        (event["id"],),
                    )
                    connection.commit()
                    continue
                if current_event["status"] not in ("PENDING", "FAILED"):
                    connection.rollback()
                    continue
                attempt_count = current_event["attempt_count"] + 1
                connection.execute(
                    "UPDATE notification_events SET status = 'SENDING', attempt_count = ?, "
                    "last_attempt_at = ? WHERE id = ?",
                    (attempt_count, timestamp(), event["id"]),
                )
                connection.commit()

            smtp_configured = bool(os.getenv("SMTP_HOST") and os.getenv("SMTP_FROM"))
            if smtp_configured:
                send_overdue_email(journey["contact_email"], journey["contact_name"], journey)
                final_status = "SENT"
            else:
                print(
                    f"[GeoPresence local notification] Overdue journey {journey['id']} "
                    f"for {journey['destination_label']}; no email sent (SMTP is not configured)."
                )
                final_status = "LOGGED"

            with closing(connect_db()) as connection:
                connection.execute(
                    "UPDATE notification_events SET status = ?, sent_at = ?, last_error = NULL "
                    "WHERE id = ?",
                    (final_status, timestamp(), event["id"]),
                )
                if final_status == "SENT":
                    connection.execute(
                        "UPDATE journeys SET status = 'OVERDUE_NOTIFIED', updated_at = ? "
                        "WHERE id = ? AND status = 'OVERDUE_PENDING'",
                        (timestamp(), journey["id"]),
                    )
                connection.commit()
        except Exception as error:
            retry_at = timestamp(
                utc_now() + timedelta(seconds=min(30 * (2 ** (attempt_count - 1)), 300))
            )
            with closing(connect_db()) as connection:
                connection.execute(
                    "UPDATE notification_events SET status = 'FAILED', next_attempt_at = ?, last_error = ? "
                    "WHERE id = ?",
                    (retry_at, str(error)[:240], event["id"]),
                )
                connection.commit()
            print(f"[GeoPresence notification error] {type(error).__name__}: {error}")


async def overdue_worker() -> None:
    while True:
        try:
            await asyncio.to_thread(process_overdue_once)
            await asyncio.to_thread(expire_incidents_once)
        except Exception as error:
            print(f"[GeoPresence worker error] {type(error).__name__}: {error}")
        await asyncio.sleep(WORKER_INTERVAL_SECONDS)


async def news_worker() -> None:
    while True:
        try:
            await asyncio.to_thread(sync_news_feeds_once)
        except Exception as error:
            print(f"[GeoPresence news worker error] {type(error).__name__}: {error}")
        await asyncio.sleep(60)


app = FastAPI(title="GeoPresence", version="0.1.0")
worker_task: asyncio.Task | None = None
news_worker_task: asyncio.Task | None = None


@app.on_event("startup")
async def start_worker() -> None:
    global worker_task, news_worker_task
    init_db()
    worker_task = asyncio.create_task(overdue_worker())
    news_worker_task = asyncio.create_task(news_worker())


@app.on_event("shutdown")
async def stop_worker() -> None:
    for task in (worker_task, news_worker_task):
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "notification_mode": "email" if os.getenv("SMTP_HOST") else "local_log"}


@app.post("/api/auth/signup", status_code=201)
def sign_up(payload: UserSignUp) -> dict:
    now = timestamp()
    user_id = str(uuid4())
    with closing(connect_db()) as connection:
        try:
            connection.execute(
                """INSERT INTO users (id, display_name, email, password_hash, created_at)
                   VALUES (?, ?, ?, ?, ?)""",
                (user_id, payload.display_name, payload.email, password_hash(payload.password), now),
            )
        except DB_INTEGRITY_ERRORS as error:
            raise HTTPException(status_code=409, detail="An account with that email already exists") from error
        token, expires_at = create_session(connection, user_id)
        connection.commit()
    return {"token": token, "expires_at": expires_at, "user": {"id": user_id, "display_name": payload.display_name, "email": payload.email}}


@app.post("/api/auth/login")
def login(payload: UserLogin) -> dict:
    with closing(connect_db()) as connection:
        user = connection.execute(
            "SELECT * FROM users WHERE email = ?", (payload.email,)
        ).fetchone()
        if user is None or not password_matches(payload.password, user["password_hash"]):
            raise HTTPException(status_code=401, detail="Email or password is incorrect")
        token, expires_at = create_session(connection, user["id"])
        connection.commit()
    return {"token": token, "expires_at": expires_at, "user": public_user(user)}


@app.get("/api/auth/me")
def current_user(authorization: str | None = Header(default=None)) -> dict:
    return public_user(require_user(authorization))


@app.post("/api/auth/logout", status_code=204)
def logout(authorization: str | None = Header(default=None)) -> None:
    supplied_token = (authorization or "").removeprefix("Bearer ").strip()
    if supplied_token:
        with closing(connect_db()) as connection:
            connection.execute("DELETE FROM auth_sessions WHERE token_hash = ?", (token_digest(supplied_token),))
            connection.commit()


@app.get("/api/news/status")
def news_status() -> dict:
    return {
        **NEWS_SYNC_STATUS,
        "enabled": bool(configured_news_feeds()),
        "sync_interval_seconds": news_sync_interval_seconds(),
        "max_article_age_hours": max(1, min(int(os.getenv("NEWS_MAX_AGE_HOURS", str(MAX_NEWS_AGE_HOURS))), 720)),
    }


@app.post("/api/news/sync")
def sync_news_now(authorization: str | None = Header(default=None)) -> dict:
    require_moderator(authorization)
    return sync_news_feeds_once(force=True)


@app.get("/api/locations/search")
def search_locations(q: str = Query(min_length=3, max_length=160)) -> list[dict]:
    return search_places(q)


@app.post("/api/incidents", status_code=201)
def create_incident(payload: IncidentCreate, request: FastAPIRequest) -> dict:
    client_key = request.client.host if request.client else "unknown-client"
    enforce_report_rate_limit(client_key)
    now = utc_now()
    now_text = timestamp(now)
    expiry_days = max(1, min(int(os.getenv("REPORT_EXPIRY_DAYS", str(DEFAULT_REPORT_EXPIRY_DAYS))), 90))
    incident_id = str(uuid4())
    reported_at = timestamp(payload.reported_at) if payload.reported_at else None
    with closing(connect_db()) as connection:
        possible_duplicates = []
        candidates = connection.execute(
            """SELECT id, latitude, longitude, reported_at, received_at FROM incident_reports
               WHERE category = ? AND is_visible = 1 AND expires_at > ?
                 AND verification_status != 'expired'""",
            (payload.category, now_text),
        ).fetchall()
        new_event_time = parse_timestamp(reported_at) if reported_at else now
        for candidate in candidates:
            candidate_event_time = parse_timestamp(candidate["reported_at"] or candidate["received_at"])
            time_delta = abs((new_event_time - candidate_event_time).total_seconds())
            distance = distance_points_m(
                payload.location.latitude,
                payload.location.longitude,
                candidate["latitude"],
                candidate["longitude"],
            )
            if time_delta <= 24 * 60 * 60 and distance <= 300:
                possible_duplicates.append(candidate["id"])

        connection.execute(
            """INSERT INTO incident_reports (
                id, title, description, category, source_type, source_url, reported_at,
                source_published_at,
                received_at, latitude, longitude, location_accuracy_m, verification_status,
                expires_at, is_visible
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unverified', ?, 1)""",
            (
                incident_id,
                payload.title,
                payload.description,
                payload.category,
                payload.source_type,
                payload.source_url,
                reported_at,
                timestamp(payload.source_published_at) if payload.source_published_at else None,
                now_text,
                payload.location.latitude,
                payload.location.longitude,
                payload.location.accuracy_m,
                timestamp(now + timedelta(days=expiry_days)),
            ),
        )
        connection.commit()
        report = incident_dict(get_incident(connection, incident_id))
    report["possible_duplicate_ids"] = possible_duplicates
    return report


@app.get("/api/incidents")
def list_incidents() -> list[dict]:
    with closing(connect_db()) as connection:
        rows = connection.execute(
            """SELECT * FROM incident_reports
               WHERE is_visible = 1 AND expires_at > ?
               ORDER BY received_at DESC LIMIT 200""",
            (timestamp(),),
        ).fetchall()
    return [incident_dict(row) for row in rows]


@app.get("/api/admin/incidents")
def list_incidents_for_moderation(
    authorization: str | None = Header(default=None),
) -> list[dict]:
    require_moderator(authorization)
    with closing(connect_db()) as connection:
        rows = connection.execute(
            "SELECT * FROM incident_reports ORDER BY received_at DESC LIMIT 500"
        ).fetchall()
    return [incident_dict(row) for row in rows]


@app.get("/api/incidents/{incident_id}")
def read_incident(incident_id: str) -> dict:
    with closing(connect_db()) as connection:
        report = get_incident(connection, incident_id)
        if not report["is_visible"] or report["expires_at"] <= timestamp():
            raise HTTPException(status_code=404, detail="Incident report not found")
        return incident_dict(report)


@app.patch("/api/incidents/{incident_id}/moderation")
def moderate_incident(
    incident_id: str,
    payload: IncidentModerationUpdate,
    authorization: str | None = Header(default=None),
) -> dict:
    actor = require_moderator(authorization)
    now = timestamp()
    with closing(connect_db()) as connection:
        report = get_incident(connection, incident_id)
        next_status = payload.verification_status or report["verification_status"]
        next_visible = int(payload.is_visible) if payload.is_visible is not None else report["is_visible"]
        duplicate_of = report["duplicate_of"]
        corrected_values = {
            field: report[field]
            for field in (
                "title", "description", "category", "source_type", "source_url",
                "reported_at", "source_published_at", "latitude", "longitude", "location_accuracy_m",
            )
        }
        changes = {}
        for field in corrected_values:
            if field not in payload.model_fields_set:
                continue
            value = getattr(payload, field)
            if field in ("reported_at", "source_published_at"):
                value = timestamp(value) if value is not None else None
            if value != corrected_values[field]:
                changes[field] = {"from": corrected_values[field], "to": value}
                corrected_values[field] = value

        if corrected_values["source_type"] == "news" and not corrected_values["source_url"]:
            raise HTTPException(status_code=422, detail="News reports require a source URL")
        if "duplicate_of" in payload.model_fields_set:
            duplicate_of = payload.duplicate_of
            if duplicate_of == incident_id:
                raise HTTPException(status_code=422, detail="A report cannot be its own duplicate")
            if duplicate_of is not None:
                duplicate = get_incident(connection, duplicate_of)
                if duplicate["category"] != report["category"]:
                    raise HTTPException(status_code=422, detail="Duplicate reports must share a category")
                if payload.is_visible is None:
                    next_visible = 0

        expires_at = report["expires_at"]
        if next_status == "expired":
            expires_at = now
        elif report["verification_status"] == "expired":
            expiry_days = max(1, min(int(os.getenv("REPORT_EXPIRY_DAYS", str(DEFAULT_REPORT_EXPIRY_DAYS))), 90))
            expires_at = timestamp(utc_now() + timedelta(days=expiry_days))

        action_parts = []
        if next_status != report["verification_status"]:
            action_parts.append("status")
        if next_visible != report["is_visible"]:
            action_parts.append("visibility")
        if duplicate_of != report["duplicate_of"]:
            action_parts.append("duplicate")
        if changes:
            action_parts.append("correction")
        action = "+".join(action_parts) or "reviewed"

        connection.execute(
            """UPDATE incident_reports SET title = ?, description = ?, category = ?, source_type = ?,
               source_url = ?, reported_at = ?, source_published_at = ?, latitude = ?, longitude = ?,
               location_accuracy_m = ?,
               verification_status = ?, is_visible = ?, duplicate_of = ?, reviewed_by = ?,
               reviewed_at = ?, expires_at = ? WHERE id = ?""",
            (
                corrected_values["title"], corrected_values["description"],
                corrected_values["category"], corrected_values["source_type"],
                corrected_values["source_url"], corrected_values["reported_at"],
                corrected_values["source_published_at"],
                corrected_values["latitude"], corrected_values["longitude"],
                corrected_values["location_accuracy_m"], next_status, next_visible,
                duplicate_of, actor, now, expires_at, incident_id,
            ),
        )
        connection.execute(
            """INSERT INTO moderation_events (
                id, incident_id, action, from_status, to_status, from_visible,
                to_visible, duplicate_of, actor, created_at, changes_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                str(uuid4()), incident_id, action, report["verification_status"], next_status,
                report["is_visible"], next_visible, duplicate_of, actor, now,
                json.dumps(changes),
            ),
        )
        connection.commit()
        return incident_dict(get_incident(connection, incident_id))


@app.get("/api/incidents/{incident_id}/history")
def incident_history(
    incident_id: str,
    authorization: str | None = Header(default=None),
) -> list[dict]:
    require_moderator(authorization)
    with closing(connect_db()) as connection:
        get_incident(connection, incident_id)
        rows = connection.execute(
            "SELECT * FROM moderation_events WHERE incident_id = ? ORDER BY created_at DESC",
            (incident_id,),
        ).fetchall()
    return [dict(row) for row in rows]


@app.get("/api/journeys")
def list_journeys(authorization: str | None = Header(default=None)) -> list[dict]:
    user = require_user(authorization)
    with closing(connect_db()) as connection:
        rows = connection.execute(
            """SELECT journeys.* FROM journeys
               LEFT JOIN journey_members ON journey_members.journey_id = journeys.id
               WHERE journeys.owner_user_id = ? OR journey_members.user_id = ?
               ORDER BY journeys.created_at DESC LIMIT 100""",
            (user["id"], user["id"]),
        ).fetchall()
    return [journey_dict(row) for row in rows]


@app.post("/api/journeys/estimate")
def estimate_journey(payload: JourneyEstimate, authorization: str | None = Header(default=None)) -> dict:
    require_user(authorization)
    route, route_source = get_route_coordinates(payload.origin, payload.destination)
    travel_seconds = estimate_travel_seconds(payload.origin, payload.destination, route, route_source)
    eta, grace_seconds = calculate_journey_schedule(payload.departure_at, travel_seconds)
    return {
        "departure_at": timestamp(max(payload.departure_at, utc_now())),
        "eta": eta,
        "estimated_duration_seconds": travel_seconds,
        "grace_period_seconds": grace_seconds,
        "route_source": route_source,
    }


@app.post("/api/journeys", status_code=201)
def create_journey(payload: JourneyCreate, authorization: str | None = Header(default=None)) -> dict:
    user = require_user(authorization)
    now = timestamp()
    journey_id = str(uuid4())
    origin_lat = payload.origin.latitude if payload.origin else None
    origin_lon = payload.origin.longitude if payload.origin else None
    route_coordinates, route_source = get_route_coordinates(payload.origin, payload.destination)
    estimated_duration_seconds = estimate_travel_seconds(
        payload.origin, payload.destination, route_coordinates, route_source
    )
    departure_at = max(payload.departure_at, utc_now())
    eta, grace_period_seconds = calculate_journey_schedule(departure_at, estimated_duration_seconds)
    serialized_route = json.dumps(route_coordinates) if route_coordinates else None
    with closing(connect_db()) as connection:
        connection.execute(
            """INSERT INTO journeys (
                id, owner_user_id, origin_lat, origin_lon, route_coordinates, route_source,
                destination_lat, destination_lon,
                destination_label, eta, grace_period_seconds, departure_at,
                estimated_duration_seconds, contact_name, contact_email,
                share_token, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)""",
            (
                journey_id,
                user["id"],
                origin_lat,
                origin_lon,
                serialized_route,
                route_source,
                payload.destination.latitude,
                payload.destination.longitude,
                payload.destination_label.strip(),
                eta,
                grace_period_seconds,
                timestamp(departure_at),
                estimated_duration_seconds,
                payload.contact_name.strip(),
                payload.contact_email,
                secrets.token_urlsafe(32),
                now,
                now,
            ),
        )
        connection.commit()
        return journey_dict(get_journey(connection, journey_id))


@app.get("/api/journeys/{journey_id}")
def read_journey(journey_id: str, authorization: str | None = Header(default=None)) -> dict:
    user = require_user(authorization)
    with closing(connect_db()) as connection:
        return journey_dict(require_journey_member(connection, journey_id, user["id"]))


@app.post("/api/journeys/{journey_id}/members", status_code=201)
def invite_journey_member(
    journey_id: str,
    payload: InviteParticipant,
    authorization: str | None = Header(default=None),
) -> dict:
    user = require_user(authorization)
    with closing(connect_db()) as connection:
        get_owned_journey(connection, journey_id, user["id"])
        invitee = connection.execute(
            "SELECT id, display_name, email FROM users WHERE email = ?", (payload.email,)
        ).fetchone()
        if invitee is None:
            raise HTTPException(status_code=404, detail="No GeoPresence account uses that email yet")
        if invitee["id"] == user["id"]:
            raise HTTPException(status_code=409, detail="You already own this journey")
        connection.execute(
            "INSERT INTO journey_members (journey_id, user_id, joined_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
            (journey_id, invitee["id"], timestamp()),
        )
        connection.commit()
        return public_user(invitee)


@app.get("/api/journeys/{journey_id}/collaboration")
def journey_collaboration(journey_id: str, authorization: str | None = Header(default=None)) -> dict:
    user = require_user(authorization)
    with closing(connect_db()) as connection:
        journey = require_journey_member(connection, journey_id, user["id"])
        members = connection.execute(
            """SELECT users.id, users.display_name, users.email, journey_member_locations.latitude,
                      journey_member_locations.longitude, journey_member_locations.accuracy,
                      journey_member_locations.updated_at
               FROM users JOIN journey_members ON journey_members.user_id = users.id
               LEFT JOIN journey_member_locations ON journey_member_locations.user_id = users.id
                 AND journey_member_locations.journey_id = journey_members.journey_id
               WHERE journey_members.journey_id = ?
               UNION ALL
               SELECT users.id, users.display_name, users.email, journey_member_locations.latitude,
                      journey_member_locations.longitude, journey_member_locations.accuracy,
                      journey_member_locations.updated_at
               FROM users LEFT JOIN journey_member_locations ON journey_member_locations.user_id = users.id
                 AND journey_member_locations.journey_id = ?
               WHERE users.id = (SELECT owner_user_id FROM journeys WHERE id = ?)""",
            (journey_id, journey_id, journey_id),
        ).fetchall()
        messages = connection.execute(
            """SELECT journey_messages.id, journey_messages.body, journey_messages.created_at,
                      users.id AS user_id, users.display_name
               FROM journey_messages JOIN users ON users.id = journey_messages.user_id
               WHERE journey_messages.journey_id = ? ORDER BY journey_messages.created_at DESC LIMIT 500""",
            (journey_id,),
        ).fetchall()
        location_history = connection.execute(
            """SELECT journey_location_history.latitude, journey_location_history.longitude,
                      journey_location_history.accuracy, journey_location_history.recorded_at,
                      users.id AS user_id, users.display_name
               FROM journey_location_history JOIN users ON users.id = journey_location_history.user_id
               WHERE journey_location_history.journey_id = ?
               ORDER BY journey_location_history.recorded_at DESC LIMIT 2000""",
            (journey_id,),
        ).fetchall()
    member_items = [dict(row) for row in members]
    for member in member_items:
        if member["updated_at"] and utc_now() - parse_timestamp(member["updated_at"]) > timedelta(seconds=60):
            member["latitude"] = None
            member["longitude"] = None
            member["accuracy"] = None
    return {
        "members": member_items,
        "messages": [dict(row) for row in reversed(messages)],
        "location_history": [dict(row) for row in reversed(location_history)],
        "route_coordinates": json.loads(journey["route_coordinates"]) if journey["route_coordinates"] else None,
        "origin": {"latitude": journey["origin_lat"], "longitude": journey["origin_lon"]}
            if journey["origin_lat"] is not None and journey["origin_lon"] is not None else None,
        "destination": {"latitude": journey["destination_lat"], "longitude": journey["destination_lon"]},
    }


@app.post("/api/journeys/{journey_id}/messages", status_code=201)
def post_journey_message(
    journey_id: str,
    payload: JourneyMessage,
    authorization: str | None = Header(default=None),
) -> dict:
    user = require_user(authorization)
    with closing(connect_db()) as connection:
        require_journey_member(connection, journey_id, user["id"])
        row = connection.execute("SELECT status FROM journeys WHERE id = ?", (journey_id,)).fetchone()
        if row["status"] in ("ARRIVED", "CANCELLED"):
            raise HTTPException(status_code=409, detail="Chat is closed for this journey")
        message_id = str(uuid4())
        created_at = timestamp()
        connection.execute(
            "INSERT INTO journey_messages (id, journey_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)",
            (message_id, journey_id, user["id"], payload.body, created_at),
        )
        connection.commit()
    return {"id": message_id, "body": payload.body, "created_at": created_at,
            "user_id": user["id"], "display_name": user["display_name"]}


@app.post("/api/journeys/{journey_id}/live-location")
def update_member_location(
    journey_id: str,
    payload: LocationUpdate,
    authorization: str | None = Header(default=None),
) -> dict:
    user = require_user(authorization)
    now = timestamp()
    with closing(connect_db()) as connection:
        journey = require_journey_member(connection, journey_id, user["id"])
        if journey["status"] in ("ARRIVED", "CANCELLED"):
            raise HTTPException(status_code=409, detail="Location sharing is closed for this journey")
        last_point = connection.execute(
            "SELECT recorded_at FROM journey_location_history WHERE journey_id = ? AND user_id = ? ORDER BY recorded_at DESC LIMIT 1",
            (journey_id, user["id"]),
        ).fetchone()
        if last_point is None or utc_now() - parse_timestamp(last_point["recorded_at"]) >= timedelta(seconds=5):
            connection.execute(
                """INSERT INTO journey_location_history
                   (id, journey_id, user_id, latitude, longitude, accuracy, recorded_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (str(uuid4()), journey_id, user["id"], payload.location.latitude,
                 payload.location.longitude, payload.accuracy_meters, now),
            )
        connection.execute(
            """INSERT INTO journey_member_locations
               (journey_id, user_id, latitude, longitude, accuracy, updated_at) VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(journey_id, user_id) DO UPDATE SET latitude=excluded.latitude,
                 longitude=excluded.longitude, accuracy=excluded.accuracy, updated_at=excluded.updated_at""",
            (journey_id, user["id"], payload.location.latitude, payload.location.longitude,
             payload.accuracy_meters, now),
        )
        connection.commit()
    return {"updated_at": now}


@app.delete("/api/journeys/{journey_id}/live-location", status_code=204)
def stop_member_location(journey_id: str, authorization: str | None = Header(default=None)) -> None:
    user = require_user(authorization)
    with closing(connect_db()) as connection:
        require_journey_member(connection, journey_id, user["id"])
        connection.execute("DELETE FROM journey_member_locations WHERE journey_id = ? AND user_id = ?",
                           (journey_id, user["id"]))
        connection.commit()


@app.get("/api/journeys/{journey_id}/export.kml")
def export_journey_kml(journey_id: str, authorization: str | None = Header(default=None)) -> Response:
    user = require_user(authorization)
    kml_ns = "http://www.opengis.net/kml/2.2"
    gx_ns = "http://www.google.com/kml/ext/2.2"
    ET.register_namespace("", kml_ns)
    ET.register_namespace("gx", gx_ns)
    qname = lambda namespace, name: f"{{{namespace}}}{name}"
    with closing(connect_db()) as connection:
        journey = require_journey_member(connection, journey_id, user["id"])
        points = connection.execute(
            """SELECT journey_location_history.latitude, journey_location_history.longitude,
                      journey_location_history.accuracy, journey_location_history.recorded_at,
                      users.display_name, users.id AS user_id
               FROM journey_location_history JOIN users ON users.id = journey_location_history.user_id
               WHERE journey_location_history.journey_id = ?
               ORDER BY journey_location_history.user_id, journey_location_history.recorded_at""",
            (journey_id,),
        ).fetchall()

    root = ET.Element(qname(kml_ns, "kml"))
    document = ET.SubElement(root, qname(kml_ns, "Document"))
    title = journey["destination_label"]
    ET.SubElement(document, qname(kml_ns, "name")).text = f"GeoPresence trip: {title}"
    ET.SubElement(document, qname(kml_ns, "description")).text = (
        f"Planned route and location points shared by trip participants. Status: {journey['status']}."
    )

    route = json.loads(journey["route_coordinates"]) if journey["route_coordinates"] else None
    if not route and journey["origin_lat"] is not None and journey["origin_lon"] is not None:
        route = [[journey["origin_lon"], journey["origin_lat"]],
                 [journey["destination_lon"], journey["destination_lat"]]]
    if route:
        placemark = ET.SubElement(document, qname(kml_ns, "Placemark"))
        ET.SubElement(placemark, qname(kml_ns, "name")).text = "Planned route"
        line = ET.SubElement(placemark, qname(kml_ns, "LineString"))
        ET.SubElement(line, qname(kml_ns, "tessellate")).text = "1"
        ET.SubElement(line, qname(kml_ns, "coordinates")).text = " ".join(
            f"{float(lon):.7f},{float(lat):.7f},0" for lon, lat in route
        )

    tracks_folder = ET.SubElement(document, qname(kml_ns, "Folder"))
    ET.SubElement(tracks_folder, qname(kml_ns, "name")).text = "Shared location history"
    grouped: dict[str, list[sqlite3.Row]] = {}
    for point in points:
        grouped.setdefault(point["user_id"], []).append(point)
    for user_points in grouped.values():
        placemark = ET.SubElement(tracks_folder, qname(kml_ns, "Placemark"))
        ET.SubElement(placemark, qname(kml_ns, "name")).text = f"Location track: {user_points[0]['display_name']}"
        if len(user_points) == 1:
            point = user_points[0]
            stamp = ET.SubElement(placemark, qname(kml_ns, "TimeStamp"))
            ET.SubElement(stamp, qname(kml_ns, "when")).text = point["recorded_at"]
            geometry = ET.SubElement(placemark, qname(kml_ns, "Point"))
            ET.SubElement(geometry, qname(kml_ns, "coordinates")).text = (
                f"{point['longitude']:.7f},{point['latitude']:.7f},0"
            )
        else:
            track = ET.SubElement(placemark, qname(gx_ns, "Track"))
            ET.SubElement(track, qname(kml_ns, "altitudeMode")).text = "clampToGround"
            for point in user_points:
                ET.SubElement(track, qname(kml_ns, "when")).text = point["recorded_at"]
                ET.SubElement(track, qname(gx_ns, "coord")).text = (
                    f"{point['longitude']:.7f} {point['latitude']:.7f} 0"
                )

    if not points and journey["location_lat"] is not None and journey["location_lon"] is not None:
        placemark = ET.SubElement(tracks_folder, qname(kml_ns, "Placemark"))
        ET.SubElement(placemark, qname(kml_ns, "name")).text = "Last location shared"
        if journey["location_at"]:
            stamp = ET.SubElement(placemark, qname(kml_ns, "TimeStamp"))
            ET.SubElement(stamp, qname(kml_ns, "when")).text = journey["location_at"]
        geometry = ET.SubElement(placemark, qname(kml_ns, "Point"))
        ET.SubElement(geometry, qname(kml_ns, "coordinates")).text = (
            f"{journey['location_lon']:.7f},{journey['location_lat']:.7f},0"
        )

    content = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    filename = re.sub(r"[^A-Za-z0-9_-]+", "-", title).strip("-_").lower()[:60] or "trip"
    return Response(
        content=content,
        media_type="application/vnd.google-earth.kml+xml",
        headers={"Content-Disposition": f'attachment; filename="geopresence-{filename}.kml"'},
    )


@app.post("/api/shared-locations/lookup")
def read_shared_location(payload: SharedLocationLookup, response: Response) -> dict:
    response.headers["Cache-Control"] = "no-store, private"
    response.headers["Referrer-Policy"] = "no-referrer"
    with closing(connect_db()) as connection:
        row = connection.execute(
            """SELECT destination_label, status, location_lat, location_lon,
                      location_accuracy, location_at
               FROM journeys WHERE share_token = ? AND status != 'CANCELLED'""",
            (payload.share_token,),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="This shared location link is no longer available")
    if row["location_lat"] is None or row["location_lon"] is None:
        return {"destination_label": row["destination_label"], "status": row["status"], "location": None}
    return {
        "destination_label": row["destination_label"],
        "status": row["status"],
        "location": {
            "latitude": row["location_lat"],
            "longitude": row["location_lon"],
            "accuracy_meters": row["location_accuracy"],
            "shared_at": row["location_at"],
        },
    }


@app.post("/api/journeys/{journey_id}/share-link/rotate")
def rotate_share_link(journey_id: str, authorization: str | None = Header(default=None)) -> dict:
    user = require_user(authorization)
    new_token = secrets.token_urlsafe(32)
    with closing(connect_db()) as connection:
        get_owned_journey(connection, journey_id, user["id"])
        connection.execute(
            "UPDATE journeys SET share_token = ?, updated_at = ? WHERE id = ?",
            (new_token, timestamp(), journey_id),
        )
        connection.commit()
        return {"share_token": new_token}


@app.get("/api/journeys/{journey_id}/threats")
def journey_threats(
    journey_id: str,
    buffer_m: int | None = Query(default=None, ge=50, le=5_000),
    authorization: str | None = Header(default=None),
) -> dict:
    user = require_user(authorization)
    effective_buffer_m = buffer_m if buffer_m is not None else configured_route_buffer_m()
    with closing(connect_db()) as connection:
        journey = get_owned_journey(connection, journey_id, user["id"])
    return {
        "journey_id": journey_id,
        "buffer_m": effective_buffer_m,
        "route_source": journey["route_source"],
        "reports": route_threats(journey_id, effective_buffer_m),
    }


@app.patch("/api/journeys/{journey_id}/eta")
def extend_eta(journey_id: str, payload: EtaUpdate, authorization: str | None = Header(default=None)) -> dict:
    user = require_user(authorization)
    with closing(connect_db()) as connection:
        journey = get_owned_journey(connection, journey_id, user["id"])
        if journey["status"] not in ("ACTIVE", "OVERDUE_PENDING"):
            raise HTTPException(status_code=409, detail="This journey can no longer be extended")
        connection.execute(
            "UPDATE journeys SET eta = ?, status = 'ACTIVE', updated_at = ? WHERE id = ?",
            (timestamp(payload.eta), timestamp(), journey_id),
        )
        connection.commit()
        return journey_dict(get_journey(connection, journey_id))


@app.post("/api/journeys/{journey_id}/arrive")
def arrive(journey_id: str, payload: LocationUpdate | None = None, authorization: str | None = Header(default=None)) -> dict:
    user = require_user(authorization)
    with closing(connect_db()) as connection:
        journey = get_owned_journey(connection, journey_id, user["id"])
        if journey["status"] not in ("ACTIVE", "OVERDUE_PENDING", "OVERDUE_NOTIFIED"):
            raise HTTPException(status_code=409, detail="This journey is already closed")
        location_values = (None, None, None, None)
        if payload:
            location_values = (
                payload.location.latitude,
                payload.location.longitude,
                payload.accuracy_meters,
                timestamp(),
            )
        now = timestamp()
        connection.execute(
            """UPDATE journeys SET status = 'ARRIVED', arrived_at = ?, updated_at = ?,
               location_lat = COALESCE(?, location_lat), location_lon = COALESCE(?, location_lon),
               location_accuracy = COALESCE(?, location_accuracy), location_at = COALESCE(?, location_at)
               WHERE id = ?""",
            (now, now, *location_values, journey_id),
        )
        connection.commit()
        return journey_dict(get_journey(connection, journey_id))


@app.post("/api/journeys/{journey_id}/undo-arrive")
def undo_arrive(journey_id: str, authorization: str | None = Header(default=None)) -> dict:
    user = require_user(authorization)
    with closing(connect_db()) as connection:
        journey = get_owned_journey(connection, journey_id, user["id"])
        if journey["status"] != "ARRIVED":
            raise HTTPException(status_code=409, detail="Only an arrived journey can be reopened")
        connection.execute(
            "UPDATE journeys SET status = 'ACTIVE', arrived_at = NULL, updated_at = ? WHERE id = ?",
            (timestamp(), journey_id),
        )
        connection.commit()
        return journey_dict(get_journey(connection, journey_id))


@app.post("/api/journeys/{journey_id}/location")
def share_location(journey_id: str, payload: LocationUpdate, authorization: str | None = Header(default=None)) -> dict:
    user = require_user(authorization)
    with closing(connect_db()) as connection:
        journey = get_owned_journey(connection, journey_id, user["id"])
        if journey["status"] not in ("ACTIVE", "OVERDUE_PENDING", "OVERDUE_NOTIFIED"):
            raise HTTPException(status_code=409, detail="Location sharing is closed for this journey")
        connection.execute(
            """UPDATE journeys SET location_lat = ?, location_lon = ?, location_accuracy = ?,
               location_at = ?, updated_at = ? WHERE id = ?""",
            (
                payload.location.latitude,
                payload.location.longitude,
                payload.accuracy_meters,
                timestamp(),
                timestamp(),
                journey_id,
            ),
        )
        connection.commit()
        return journey_dict(get_journey(connection, journey_id))


@app.post("/api/journeys/{journey_id}/cancel")
def cancel(journey_id: str, authorization: str | None = Header(default=None)) -> dict:
    user = require_user(authorization)
    with closing(connect_db()) as connection:
        journey = get_owned_journey(connection, journey_id, user["id"])
        if journey["status"] in ("ARRIVED", "CANCELLED"):
            raise HTTPException(status_code=409, detail="This journey is already closed")
        now = timestamp()
        connection.execute(
            "UPDATE journeys SET status = 'CANCELLED', cancelled_at = ?, updated_at = ? WHERE id = ?",
            (now, now, journey_id),
        )
        connection.execute(
            "UPDATE notification_events SET status = 'CANCELLED' "
            "WHERE journey_id = ? AND status IN ('PENDING', 'FAILED')",
            (journey_id,),
        )
        connection.commit()
        return journey_dict(get_journey(connection, journey_id))


@app.get("/api/notifications")
def list_notifications(authorization: str | None = Header(default=None)) -> list[dict]:
    user = require_user(authorization)
    with closing(connect_db()) as connection:
        rows = connection.execute(
            """SELECT n.id, n.journey_id, j.destination_label, n.status, n.attempt_count,
                      n.created_at, n.last_attempt_at, n.sent_at, n.last_error
               FROM notification_events n JOIN journeys j ON j.id = n.journey_id
               WHERE j.owner_user_id = ? ORDER BY n.created_at DESC LIMIT 100""",
            (user["id"],),
        ).fetchall()
    return [dict(row) for row in rows]


@app.get("/api/config")
def config() -> dict:
    return {
        "notification_mode": "email" if os.getenv("SMTP_HOST") and os.getenv("SMTP_FROM") else "local_log",
        "moderation_enabled": bool(os.getenv("MODERATOR_TOKEN")),
        "route_alert_buffer_m": configured_route_buffer_m(),
        "live_news_enabled": bool(configured_news_feeds()),
        "news_sync_interval_seconds": news_sync_interval_seconds(),
    }


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
