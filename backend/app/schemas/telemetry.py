"""AeroShield - aircraft position telemetry.

WHY THIS EXISTS AT ALL, given detections already carry coordinates.

A detection tells you where a *thing* was when a frame happened to contain it.
It cannot tell you where the *aircraft* is, and it is silent for the first
minutes of a flight, through every stretch of empty ground, and for the whole
time after the last find. A dashboard that derived the drone marker from
detection geotags would show an aircraft that is invisible at takeoff, frozen
between finds, and sitting still during the return leg - and an operator who
cannot see the aircraft cannot tell "no mines here" from "the link is down".

So position is its own stream, at its own cadence (about 1 Hz), independent of
whether anything was detected. That is also what makes it cheap: this is a few
hundred bytes a second, against a JPEG per detection.

WHY /latest AND NOT A WEBSOCKET, YET.
A websocket would be lower latency and is where this ends up (the mission
socket is scheduled work). Polling is what ships today because it needs no
connection lifecycle, no reconnect logic, and no server state: the dashboard
asks "where is it now?" and the answer is a single indexed row. The row is
still written per telemetry frame, so the timeline is not lost when the socket
does arrive - it just starts being pushed as well as read.

THE ONE THING THIS MUST NOT DO IS RATE-LIMIT.
The drone flies a 10 m block and beacons once a second. Over a two-hour
session that is 7,200 rows for one aircraft, which is nothing. But a telemetry
endpoint that writes a row per request is a write amplifier if it is ever
polled from a browser that retries, so the ingest path is deliberately the
drone's and the read path is separate.
"""

from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field


class TelemetryIngest(BaseModel):
    """POST /api/missions/{id}/telemetry - one position frame from the aircraft.

    Every field except the position is optional. The drone may have a position
    and no battery reading, or a link and no altitude, and refusing the frame
    for a missing battery percentage would lose the position - which is the
    only field this endpoint truly needs to answer "where is the drone?".
    """

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "latitude": 17.396947,
                "longitude": 78.490706,
                "altitude_m": 4.2,
                "heading_deg": 90.0,
                "ground_speed_ms": 1.0,
                "gps_fix_type": 3,
                "satellites_visible": 14,
                "battery_pct": 78,
                "battery_volts": 21.4,
                "link_pct": 94,
                "flight_mode": "MANUAL",
                "armed": True,
                "captured_at": "2026-08-24T14:23:17.481Z",
            }
        }
    )

    # --- position: the only required part ---------------------------------
    latitude: float = Field(ge=-90.0, le=90.0)
    longitude: float = Field(ge=-180.0, le=180.0)

    # --- attitude and motion ----------------------------------------------
    altitude_m: Optional[float] = Field(
        default=None, description="Altitude above mean sea level, metres."
    )
    relative_altitude_m: Optional[float] = Field(
        default=None, description="Altitude above the launch point - what the geotag error budget uses."
    )
    heading_deg: Optional[float] = Field(default=None, ge=0.0, lt=360.0)
    ground_speed_ms: Optional[float] = Field(default=None, ge=0.0)

    # --- fix quality ------------------------------------------------------
    # Stored, not just displayed. A position logged with a 2D fix is a position
    # with a known-worse error, and the difference matters when someone later
    # asks whether a survey pass was trustworthy.
    gps_fix_type: Optional[int] = Field(
        default=None, ge=0, le=8,
        description="ArduPilot GPS_FIX_TYPE. 3 = 3D fix, 6 = RTK fixed.",
    )
    satellites_visible: Optional[int] = Field(default=None, ge=0, le=64)

    # --- aircraft state ---------------------------------------------------
    battery_pct: Optional[int] = Field(default=None, ge=0, le=100)
    battery_volts: Optional[float] = Field(default=None, ge=0.0)
    link_pct: Optional[int] = Field(
        default=None, ge=0, le=100, description="Radio link quality, percent."
    )
    flight_mode: Optional[str] = Field(default=None, max_length=20)
    armed: Optional[bool] = None

    captured_at: datetime = Field(
        description="Drone clock, at capture. Ordering a flight by this and never "
                    "by arrival time is what keeps a spooled replay in the right "
                    "order after a link outage."
    )


class TelemetryRead(TelemetryIngest):
    """GET .../telemetry/latest - a stored frame, with the server's bookkeeping."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    mission_id: Optional[int] = None
    created_at: datetime


class TelemetryTrack(BaseModel):
    """GET .../telemetry - the flight's recent positions, oldest first.

    Returned oldest-first because every consumer of it draws a line, and a
    polyline built from newest-first data is a polyline that has to be reversed
    at the call site or it renders backwards from the aircraft.
    """

    mission_id: int
    mission_name: Optional[str] = None
    count: int = Field(description="Number of frames in `items`, after the limit.")
    items: List[TelemetryRead]


class TelemetryLatest(BaseModel):
    """The answer to "where is the drone right now?".

    Shaped so the dashboard can render its offline state without guessing:
    `found=false` means no telemetry has ever arrived for this mission, which is
    a different thing from a stale frame, and different again from a live one.
    `age_s` is the server's own measurement of how old the newest frame is, so
    the client does not have to trust its own clock against the drone's.
    """

    found: bool
    mission_id: int
    mission_name: Optional[str] = None
    telemetry: Optional[TelemetryRead] = None
    age_s: Optional[float] = Field(
        default=None,
        description="Seconds since the newest frame was captured, server-side. "
                    "None when found=false.",
    )
    live: bool = Field(
        default=False,
        description="True when the newest frame is inside the freshness window "
                    "(see TELEMETRY_LIVE_WINDOW_S). False means the aircraft has "
                    "gone quiet - the link is down, or the flight ended.",
    )
