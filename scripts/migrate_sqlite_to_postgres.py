"""Copy the local GeoPresence SQLite database into an empty PostgreSQL database."""

from __future__ import annotations

import os
import sqlite3
import sys
from contextlib import closing
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
if not DATABASE_URL:
    raise SystemExit("Set DATABASE_URL to the target PostgreSQL connection string first.")

SOURCE_PATH = Path(os.getenv("GEOPRESENCE_DATABASE", ROOT / "data" / "geopresence.sqlite3"))
if not SOURCE_PATH.is_file():
    raise SystemExit(f"SQLite source database not found: {SOURCE_PATH}")

from app.main import connect_db, init_db  # noqa: E402


TABLES = (
    "users",
    "journeys",
    "auth_sessions",
    "journey_members",
    "journey_messages",
    "journey_member_locations",
    "journey_location_history",
    "notification_events",
    "incident_reports",
    "moderation_events",
)


def main() -> None:
    init_db()
    with closing(sqlite3.connect(SOURCE_PATH)) as source, closing(connect_db()) as target:
        source.row_factory = sqlite3.Row
        existing = {
            table: target.execute(f"SELECT COUNT(*) AS count FROM {table}").fetchone()["count"]
            for table in TABLES
        }
        occupied = [table for table, count in existing.items() if count]
        if occupied:
            raise SystemExit(
                "Refusing to merge into a non-empty PostgreSQL database. "
                f"Rows already exist in: {', '.join(occupied)}"
            )

        copied = {}
        try:
            for table in TABLES:
                rows = source.execute(f"SELECT * FROM {table}").fetchall()
                if not rows:
                    copied[table] = 0
                    continue
                columns = rows[0].keys()
                column_sql = ", ".join(columns)
                value_sql = ", ".join("?" for _ in columns)
                query = (
                    f"INSERT INTO {table} ({column_sql}) VALUES ({value_sql}) "
                    "ON CONFLICT DO NOTHING"
                )
                for row in rows:
                    target.execute(query, tuple(row[column] for column in columns))
                copied[table] = len(rows)
            target.commit()
        except Exception:
            target.rollback()
            raise

    for table, count in copied.items():
        print(f"{table}: {count} rows copied")


if __name__ == "__main__":
    main()
