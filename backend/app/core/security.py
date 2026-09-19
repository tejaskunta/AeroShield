"""AeroShield - API key generation, hashing and scope checks.

Week 5 asks for "user authentication and authorization" and "secure communication
between drone and server". Those are one mechanism here - scoped API keys - which
covers both clients without a login flow the drone cannot sensibly perform.

WHY SHA-256 AND NOT BCRYPT.
bcrypt/argon2 exist to make brute-forcing *low-entropy* secrets expensive: a human
password has maybe 30 bits of entropy, so you deliberately spend 100ms per guess.
These keys are 256 bits from `secrets.token_urlsafe(32)`. There is nothing to
brute-force, so a slow KDF buys no security and costs 100ms on every single drone
POST - which, at several detections per second over a radio link, is a real budget.
A single SHA-256 over a high-entropy token is the correct construction.

WHAT THIS DOES NOT DO.
Keys are bearer credentials sent in a header. Over plain HTTP they are readable by
anything on the path. "Secure communication" is only true end to end if the
deployment terminates TLS - put the API behind HTTPS before it leaves the bench.
Noted in docs/API.md as a deployment requirement, not solved in code.

Week 6 note: the React dashboard will want a human login. Add a JWT verifier that
resolves to the same ScopedPrincipal shape that require_scope() consumes, and no
route needs to change.
"""

import hashlib
import hmac
import secrets
from typing import Iterable, List, Sequence, Tuple

# Human-visible prefix, so a leaked string is recognisable as an AeroShield
# credential in a log or a paste and can be revoked without guesswork.
KEY_PREFIX = "aero_"

# Characters of the full key kept in plaintext for display ("aero_x7Kd2p..."). Long
# enough to identify a key in a list, far too short to be usable.
DISPLAY_PREFIX_LEN = 12

# --- scopes ------------------------------------------------------------------
SCOPE_DRONE_INGEST = "drone:ingest"        # POST detections, create missions
SCOPE_DETECTIONS_READ = "detections:read"  # read detections/missions (dashboard)
SCOPE_MISSIONS_WRITE = "missions:write"    # create/update missions
SCOPE_ADMIN = "admin"                      # manage keys, delete detections

ALL_SCOPES: Tuple[str, ...] = (
    SCOPE_DRONE_INGEST,
    SCOPE_DETECTIONS_READ,
    SCOPE_MISSIONS_WRITE,
    SCOPE_ADMIN,
)

# Convenience bundles for scripts/create_api_key.py.
SCOPE_PRESETS = {
    "drone": [SCOPE_DRONE_INGEST, SCOPE_MISSIONS_WRITE],
    "dashboard": [SCOPE_DETECTIONS_READ],
    "operator": [SCOPE_DETECTIONS_READ, SCOPE_MISSIONS_WRITE],
    "admin": list(ALL_SCOPES),
}


def generate_api_key() -> str:
    """A fresh key. Returned once, never recoverable - only its hash is stored."""
    return KEY_PREFIX + secrets.token_urlsafe(32)


def hash_api_key(key: str) -> str:
    """Hex SHA-256 of the key. Deterministic, so it can be a unique index."""
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def display_prefix(key: str) -> str:
    """The leading fragment kept in the clear for identification."""
    return key[:DISPLAY_PREFIX_LEN]


def verify_api_key(presented: str, stored_hash: str) -> bool:
    """Constant-time comparison.

    Lookup is by hash, so this is belt-and-braces rather than the primary check -
    but it costs nothing and means a future lookup-by-prefix refactor stays safe.
    """
    return hmac.compare_digest(hash_api_key(presented), stored_hash)


def normalise_scopes(scopes: Iterable[str]) -> List[str]:
    """Validate, de-duplicate and sort. Raises on anything unrecognised.

    Rejecting unknown scopes matters: a typo like "detection:read" would silently
    create a key that authorises nothing, and the failure would surface later as a
    confusing 403 from the dashboard.
    """
    cleaned = []
    unknown = []
    for scope in scopes:
        scope = (scope or "").strip()
        if not scope:
            continue
        if scope not in ALL_SCOPES:
            unknown.append(scope)
        elif scope not in cleaned:
            cleaned.append(scope)

    if unknown:
        raise ValueError(
            "Unknown scope(s): {0}. Valid scopes: {1}".format(
                ", ".join(sorted(unknown)), ", ".join(ALL_SCOPES)
            )
        )
    if not cleaned:
        raise ValueError(
            "At least one scope is required. Valid scopes: {0}".format(", ".join(ALL_SCOPES))
        )
    return sorted(cleaned)


def has_scope(granted: Sequence[str], required: str) -> bool:
    """Scope check. `admin` implies every other scope."""
    if not granted:
        return False
    return SCOPE_ADMIN in granted or required in granted
