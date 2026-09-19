#!/usr/bin/env python3
"""AeroShield - mint an API key from the command line.

Solves the bootstrap problem: POST /api/admin/api-keys needs an admin key, and on a
fresh database there isn't one. This writes straight to the database instead.

    cd backend
    python scripts/create_api_key.py --name laptop --preset admin
    python scripts/create_api_key.py --name drone-01 --preset drone
    python scripts/create_api_key.py --name dashboard --scopes detections:read

    python scripts/create_api_key.py --list
    python scripts/create_api_key.py --revoke 3

The key is printed once. Only its SHA-256 hash is stored, so it cannot be recovered
afterwards - if it is lost, revoke it and mint another.
"""

import argparse
import asyncio
import sys
from pathlib import Path

# Allow `python scripts/create_api_key.py` from backend/ without installing the package.
BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from sqlalchemy import select                                    # noqa: E402

from app.core.security import (                                  # noqa: E402
    ALL_SCOPES,
    SCOPE_PRESETS,
    display_prefix,
    generate_api_key,
    hash_api_key,
    normalise_scopes,
)
from app.db.models.api_key import ApiKey                         # noqa: E402
from app.db.session import SessionLocal, dispose_engine          # noqa: E402


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Create, list or revoke AeroShield API keys.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "presets:\n"
            + "\n".join("  {0:<12} {1}".format(name, ", ".join(scopes))
                        for name, scopes in sorted(SCOPE_PRESETS.items()))
            + "\n\nvalid scopes:\n  " + "\n  ".join(ALL_SCOPES)
        ),
    )
    p.add_argument("--name", help="Label for the holder, e.g. 'drone-01'")
    p.add_argument("--preset", choices=sorted(SCOPE_PRESETS.keys()),
                   help="Named scope bundle")
    p.add_argument("--scopes", help="Comma-separated explicit scopes")
    p.add_argument("--list", action="store_true", dest="do_list",
                   help="List existing keys and exit")
    p.add_argument("--include-revoked", action="store_true",
                   help="Include revoked keys in --list")
    p.add_argument("--revoke", type=int, metavar="ID", help="Revoke the key with this id")
    return p.parse_args()


async def list_keys(include_revoked: bool) -> int:
    async with SessionLocal() as db:
        query = select(ApiKey).order_by(ApiKey.id)
        if not include_revoked:
            query = query.where(ApiKey.is_active.is_(True))
        keys = list((await db.execute(query)).scalars().all())

    if not keys:
        print("No API keys found. Create one with:")
        print("    python scripts/create_api_key.py --name laptop --preset admin")
        return 0

    print("{0:>4}  {1:<20} {2:<14} {3:<8} {4:<20} {5}".format(
        "id", "name", "prefix", "active", "last used", "scopes"))
    print("-" * 100)
    for key in keys:
        print("{0:>4}  {1:<20} {2:<14} {3:<8} {4:<20} {5}".format(
            key.id,
            key.name[:20],
            key.key_prefix,
            "yes" if key.is_active else "no",
            key.last_used_at.strftime("%Y-%m-%d %H:%M") if key.last_used_at else "never",
            ",".join(key.scopes or []),
        ))
    return 0


async def revoke_key(key_id: int) -> int:
    async with SessionLocal() as db:
        key = await db.get(ApiKey, key_id)
        if key is None:
            print("ERROR: no API key with id {0}".format(key_id), file=sys.stderr)
            return 1
        if not key.is_active:
            print("API key {0} ('{1}') was already revoked.".format(key_id, key.name))
            return 0
        key.is_active = False
        await db.commit()
        print("Revoked API key {0} ('{1}').".format(key_id, key.name))
    return 0


async def create_key(name: str, preset: str, scopes_csv: str) -> int:
    if preset and scopes_csv:
        print("ERROR: use --preset or --scopes, not both.", file=sys.stderr)
        return 1

    if preset:
        scopes = SCOPE_PRESETS[preset]
    elif scopes_csv:
        scopes = [s.strip() for s in scopes_csv.split(",")]
    else:
        print("ERROR: one of --preset or --scopes is required.", file=sys.stderr)
        print("       e.g. --preset drone", file=sys.stderr)
        return 1

    try:
        scopes = normalise_scopes(scopes)
    except ValueError as exc:
        print("ERROR: {0}".format(exc), file=sys.stderr)
        return 1

    plaintext = generate_api_key()
    async with SessionLocal() as db:
        db.add(ApiKey(
            name=name,
            key_prefix=display_prefix(plaintext),
            key_hash=hash_api_key(plaintext),
            scopes=scopes,
            is_active=True,
        ))
        await db.commit()

    print("")
    print("=" * 78)
    print("  API key created")
    print("=" * 78)
    print("  name   : {0}".format(name))
    print("  scopes : {0}".format(", ".join(scopes)))
    print("")
    print("  {0}".format(plaintext))
    print("")
    print("  Copy it now. Only a SHA-256 hash is stored, so this is the only time")
    print("  it can be shown. If you lose it, revoke the key and make another.")
    print("")
    print("  Use it with the drone:")
    print("    export AEROSHIELD_API_KEY={0}".format(plaintext))
    print("    python3 jetson/live_detect.py --detector mock --gps sim \\")
    print("        --mission-name bench-1 --headless --max-frames 60")
    print("")
    print("  Or with curl:")
    print("    curl -H 'X-API-Key: {0}' http://127.0.0.1:8000/api/auth/me".format(plaintext))
    print("=" * 78)
    print("")
    return 0


async def run(args: argparse.Namespace) -> int:
    try:
        if args.do_list:
            return await list_keys(args.include_revoked)
        if args.revoke is not None:
            return await revoke_key(args.revoke)
        if not args.name:
            print("ERROR: --name is required to create a key.", file=sys.stderr)
            print("       python scripts/create_api_key.py --name laptop --preset admin",
                  file=sys.stderr)
            return 1
        return await create_key(args.name, args.preset, args.scopes)
    except Exception as exc:                        # noqa: BLE001
        message = str(exc)
        print("ERROR: {0}".format(message), file=sys.stderr)
        # The two failures that actually happen, and what to do about them.
        if "does not exist" in message or "UndefinedTable" in message:
            print("\nThe tables are missing. Run the migrations first:", file=sys.stderr)
            print("    cd backend && alembic upgrade head", file=sys.stderr)
        elif "Connect call failed" in message or "could not connect" in message.lower():
            print("\nThe database is not reachable. Start it:", file=sys.stderr)
            print("    docker compose up -d db", file=sys.stderr)
        return 1
    finally:
        await dispose_engine()


def main() -> int:
    return asyncio.run(run(parse_args()))


if __name__ == "__main__":
    sys.exit(main())
