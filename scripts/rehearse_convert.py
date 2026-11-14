#!/usr/bin/env python3
"""Turn the captured spool into a video file, so the real detector can be driven.

WHY THIS EXISTS
`scripts/rehearse_local.py` proves the ingest plumbing by POSTing records that
the aircraft already produced. It cannot prove anything about `jetson/live_detect.py`,
because it never runs it: it starts at the HTTP boundary, one layer below the
code that matters in flight.

The obstacle is that the detector reads *frames*, and there is no camera here.
It can read a video file (`open_source` accepts .mp4/.avi/.mov/.mkv), and the
repo already has 647 real captures in the spool - frames off the actual camera,
with the actual subject. So: assemble those into a short AVI and the real capture
-> infer -> geotag -> uplink -> log path runs on a laptop, end to end, with the
real code.

A single still is not enough, and that is the whole reason for a sequence. Three
of the properties worth testing are only observable over time:

  * the spool/dedupe path - `BoxHold` suppresses repeat boxes for `--box-hold`
    seconds, and a one-frame input cannot exercise a hold;
  * `detections.jsonl` accumulation - one row proves a write, a sequence proves a
    log that stays well-formed as it grows;
  * the frame counter, `--max-frames`, and the telemetry cadence.

WHAT IT DOES NOT DO
It does not detect anything, encode anything clever, or stand in for the camera.
It re-encodes real captures at a modest rate so a laptop can chew through them
faster than real time. The model is still the model; if there are no weights this
runs with `--detector mock` and proves the *plumbing*, which is exactly what the
rest of the rehearsal claims and no more.

USAGE
    .venv-rehearsal/Scripts/python scripts/rehearse_convert.py

Writes `rehearsal-frames.avi` in a temp directory by default and prints the path,
so `scripts/rehearse_full.py` can consume it without a committed binary. Pass
`--out` to keep it somewhere.

Needs OpenCV. It is deliberately NOT run from `backend/.venv`: that environment
belongs to the API and must not grow a video stack. `.venv-rehearsal` exists for
this and nothing else.
"""

import argparse
import os
import random
import sys
import tempfile

try:
    import cv2
except ImportError:
    sys.stderr.write(
        "rehearse_convert needs OpenCV, which the API's venv deliberately does\n"
        "not have. Use the rehearsal environment:\n"
        "    py -3.11 -m venv .venv-rehearsal\n"
        "    .venv-rehearsal/Scripts/python -m pip install opencv-python-headless numpy\n"
    )
    raise SystemExit(2)

# Matches what the aircraft captures and what the engine was trained for. The
# detector letterboxes whatever it is given, so a mismatch would not break it -
# but using the native size keeps the rehearsal honest about the pixel budget.
DEFAULT_W, DEFAULT_H = 512, 288

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
DEFAULT_SPOOL = os.path.join(REPO, "drone-data", "aeroshield", "jetson", "spool")


def list_frames(spool_dir):
    """The .jpg files in a spool directory, in a stable order.

    Sorted rather than in `listdir` order because the spool names are UUIDs and
    the filesystem's order is arbitrary; a run that picks different frames on
    different machines is a run whose output cannot be compared against last
    time's. `rejected/` is a subdirectory and is skipped, but its contents are
    still picked up when `--include-rejected` is asked for by the caller.
    """
    try:
        names = os.listdir(spool_dir)
    except OSError as exc:
        raise SystemExit("cannot read the spool at {0}: {1}".format(spool_dir, exc))
    return sorted(
        os.path.join(spool_dir, n)
        for n in names
        if n.lower().endswith(".jpg")
    )


def build_avi(frames, out_path, fps, size, limit, seed):
    """Write `frames` to an AVI and return (path, frames_written, width, height).

    Every frame is re-encoded rather than copied, because AVI/JPEG needs a
    container the decoder understands and the captures are bare JPEGs. Quality
    is left at OpenCV's default: this file is an input to a detector, not
    something a human grades, and a second lossy pass at high quality is
    indistinguishable to the model.

    Frames that fail to decode are skipped rather than fatal. The spool holds
    thousands of files written by a process that can be killed mid-write, so one
    truncated capture is expected; refusing the whole run over it would make the
    rehearsal fragile in exactly the way that stops people running it.
    """
    if limit and len(frames) > limit:
        rng = random.Random(seed)
        frames = rng.sample(frames, limit)

    w, h = size
    fourcc = cv2.VideoWriter_fourcc(*"MJPG")
    writer = cv2.VideoWriter(out_path, fourcc, float(fps), (w, h))
    if not writer.isOpened():
        raise SystemExit(
            "could not open a video writer at {0} - the OpenCV build has no MJPG "
            "encoder".format(out_path)
        )

    written = 0
    skipped = 0
    try:
        for path in frames:
            img = cv2.imread(path)
            if img is None:
                skipped += 1
                continue
            # Every frame goes through resize unconditionally: the whole clip must
            # be one size, because a mismatch mid-file makes some decoders stop at
            # the first difference and silently replay a truncated flight.
            if img.shape[1] != w or img.shape[0] != h:
                img = cv2.resize(img, (w, h), interpolation=cv2.INTER_AREA)
            writer.write(img)
            written += 1
    finally:
        writer.release()

    return out_path, written, skipped


def main(argv=None):
    p = argparse.ArgumentParser(
        description="Assemble captured spool frames into an AVI the detector can read.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--spool", default=DEFAULT_SPOOL,
                   help="directory of captured .jpg frames")
    p.add_argument("--out", default=None,
                   help="output .avi (default: a temp file, path printed)")
    p.add_argument("--limit", type=int, default=60,
                   help="use at most this many frames, sampled at random; 0 = all")
    p.add_argument("--fps", type=float, default=10.0,
                   help="clip rate; drives how fast --max-frames is consumed")
    p.add_argument("--width", type=int, default=DEFAULT_W)
    p.add_argument("--height", type=int, default=DEFAULT_H)
    p.add_argument("--seed", type=int, default=20260824,
                   help="fixed by default so every run uses the same frames")
    p.add_argument("--quiet", action="store_true")
    args = p.parse_args(argv)

    frames = list_frames(args.spool)
    if not frames:
        raise SystemExit(
            "no .jpg frames in {0}\n"
            "  the spool is gitignored; this needs a machine that has flown, or\n"
            "  use scripts/dev_mjpeg.py for a synthetic feed instead.".format(args.spool)
        )

    if args.out:
        out_path = args.out
        tmpdir = None
    else:
        tmpdir = tempfile.mkdtemp(prefix="aeroshield-rehearsal-clip-")
        out_path = os.path.join(tmpdir, "rehearsal-frames.avi")

    path, written, skipped = build_avi(
        frames, out_path, args.fps, (args.width, args.height), args.limit, args.seed
    )

    if written == 0:
        raise SystemExit("every frame failed to decode - is {0} really JPEGs?".format(args.spool))

    if not args.quiet:
        print("clip     : {0}".format(path))
        print("frames   : {0} written, {1} undecodable".format(written, skipped))
        print("geometry : {0}x{1} at {2:g} fps (~{3:.0f}s)".format(
            args.width, args.height, args.fps, written / max(args.fps, 0.001)))
        print("source   : {0} ({1} available)".format(args.spool, len(frames)))
        if tmpdir:
            print("note     : temp directory, safe to delete after the run")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())