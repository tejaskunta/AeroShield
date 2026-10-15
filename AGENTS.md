# AGENTS.md

## Jetson constraints
- Target: Jetson Nano, JetPack 4.6 (L4T R32.7.6), Python 3.6 only. No walrus operator, no dataclasses, no `from __future__ import annotations`.
- Access: `ssh jetson` (user kmit, LAN 10.11.101.241).
- Do not change power mode, swap, JetPack/L4T, or system packages without explicit user approval.

## Make targets
- `make deploy`: rsync `jetson/` to the Jetson.
- `make bench`: run detector help on the Jetson.
- `make run`: start headless live detection on the Jetson.
- `make logs`: tail the Jetson detection log.
- `make test-local`: run root pytest on the laptop.
