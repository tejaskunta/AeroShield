#!/usr/bin/env bash
#
# Build a Python 3.6-importable pymavlink + pyserial payload for the Jetson Nano.
#
# WHY THIS EXISTS
#
# The Nano has two interpreters and each has exactly half of what a flight needs:
#
#   /usr/bin/python3.6 (3.6.9)   TensorRT 8.2.1.9, pycuda, cv2 4.1.1 w/ GStreamer
#                                -> but NO pymavlink, NO pyserial
#   /usr/bin/python3    (3.10.4) pymavlink 2.4.50, pyserial, cv2 4.12.0
#                                -> but NO TensorRT
#
# `--detector trt` needs 3.6 and `--gps mavlink` needs pymavlink, so the GPS and
# the GPU have to end up on the same interpreter. That interpreter is 3.6.
#
# Installing there is not a `pip install`:
#
#   1. pip on this image is broken. `pip --version` dies inside a bundled
#      distro.py that shells out to `lsb_release`, and `lsb_release` itself dies
#      with ModuleNotFoundError because its module lives in
#      /usr/lib/python3/dist-packages - a path `/usr/bin/python3 -Es` does not
#      search (-E ignores PYTHONPATH, -s ignores user site). Both failures
#      happen while importing pip, before any argument is parsed, so no pip flag
#      works around them. Patching that would be a system-package change.
#
#   2. Even with a working pip, pymavlink >= 2.4.44 cannot run on 3.6: mavutil.py
#      opens with `from __future__ import annotations`, which is Python 3.7+, and
#      raises SyntaxError on 3.6. PyPI publishes no cp36 wheel either, so pip
#      would fall back to a source build - which needs pip, i.e. problem 1.
#
# So this script sidesteps pip entirely. It pins the newest release that still
# parses as Python 3.6, generates the MAVLink dialects with the package's own
# pure-Python generator, and emits a tarball that `make deps-drone` unpacks
# straight into ~/.local/lib/python3.6/site-packages. No compiler, no pip, no
# sudo, nothing written outside the user's home directory.
#
# Run this on the LAPTOP (it needs network and a python3 to run the generator),
# then let `make deps-drone` ship the result.
#
# Usage:
#   scripts/build_py36_deps.sh [output.tar.gz]

set -euo pipefail

OUT="${1:-/tmp/aeroshield_py36_deps.tar.gz}"
PYMAVLINK_VER="2.4.42"     # newest release that still parses on Python 3.6
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

say() { printf '  %s\n' "$*"; }

printf '\n== building Python 3.6 dependency payload ==\n\n'

# ---------------------------------------------------------------------------
# 1. Fetch sources
# ---------------------------------------------------------------------------
say "fetching pymavlink ${PYMAVLINK_VER} + pyserial sdists"

# PyPI's JSON endpoint is /pypi/<name>/json for the latest release and
# /pypi/<name>/<version>/json for a specific one, so the version is optional.
sdist_url() {
    local name="$1" version="${2:-}"
    local endpoint="https://pypi.org/pypi/${name}/json"
    [ -n "$version" ] && endpoint="https://pypi.org/pypi/${name}/${version}/json"

    curl -fsS --max-time 30 "$endpoint" \
        | python3 -c "import json,sys
d=json.load(sys.stdin)
for f in d['urls']:
    if f['packagetype']=='sdist':
        print(f['url']); break
else:
    raise SystemExit('no sdist published for ${name} ${version}')"
}

PM_URL="$(sdist_url pymavlink "$PYMAVLINK_VER")"
PS_URL="$(sdist_url pyserial)"

mkdir -p "$WORK/src"
curl -fsS --max-time 120 -o "$WORK/pm.tar.gz" "$PM_URL"
curl -fsS --max-time 120 -o "$WORK/ps.tar.gz" "$PS_URL"
tar xzf "$WORK/pm.tar.gz" -C "$WORK/src"
tar xzf "$WORK/ps.tar.gz" -C "$WORK/src"

PM_DIR="$(find "$WORK/src" -maxdepth 1 -type d -name 'pymavlink-*' | head -1)"
PS_DIR="$(find "$WORK/src" -maxdepth 1 -type d -name 'pyserial-*' | head -1)"
[ -n "$PM_DIR" ] || { echo "ERROR: pymavlink sdist did not unpack"; exit 1; }
[ -n "$PS_DIR" ] || { echo "ERROR: pyserial sdist did not unpack"; exit 1; }

# ---------------------------------------------------------------------------
# 2. Verify the pin is still 3.6-safe before doing anything with it
# ---------------------------------------------------------------------------
# PEP 563 (`from __future__ import annotations`) is a SyntaxError on 3.6. If a
# future sdist ever gains it here, fail loudly rather than shipping a payload
# that dies on the aircraft with a confusing traceback.
if grep -rqs "__future__ import annotations" "$PM_DIR/pymavlink" "$PM_DIR"/*.py 2>/dev/null; then
    echo "ERROR: pymavlink ${PYMAVLINK_VER} uses PEP 563 and cannot run on Python 3.6."
    echo "       Pick an older pin (2.4.42 and below were verified)."
    exit 1
fi
say "pymavlink ${PYMAVLINK_VER} is free of PEP 563 - OK"

# ---------------------------------------------------------------------------
# 3. Lay the package out the way setup.py would
# ---------------------------------------------------------------------------
# The sdist is FLAT: mavutil.py, mavwp.py, dialects/, ... all sit at the archive
# root, and setup.py installs them as a package via
#
#     package_dir = {'pymavlink': '.'}
#
# So the installed form is pymavlink/<all those files>, which is not what the
# sdist looks like. Copying the sdist's `pymavlink/` directory alone therefore
# yields a package containing only `dialects/` and no `mavutil` - which imports
# as `pymavlink` and then fails on `from pymavlink import mavutil`. That is the
# exact failure this step exists to prevent.
PKG="$WORK/pkg"
mkdir -p "$PKG/pymavlink"
cp "$PM_DIR"/*.py "$PKG/pymavlink/"
cp -r "$PM_DIR/dialects" "$PM_DIR/generator" "$PKG/pymavlink/"
rm -f "$PKG/pymavlink/setup.py"
rm -rf "$PKG/pymavlink/dfindexer"      # Cython .so built for 3.10; optional, must not ship

# ---------------------------------------------------------------------------
# 4. Generate the MAVLink dialects
# ---------------------------------------------------------------------------
# The sdist ships .xml definitions, not generated Python - setup.py runs the
# generator at build time. The generator is pure Python, so it runs anywhere
# (including here on the laptop), and its output is plain Python with no version
# constraints of its own. Every dialect is generated, not just ardupilotmega,
# because gps.py resolves message classes by name and a missing dialect would
# only surface as an AttributeError mid-flight.
say "generating MAVLink dialects (pure Python)"
# mavgen is extremely chatty on stdout (a full parse/generate trace per dialect,
# ~200 lines). It is silenced here and every failure is reported explicitly
# below, so nothing important is hidden by the redirect.
python3 - "$PKG/pymavlink" "$PM_DIR" >/dev/null <<'PY'
import glob, os, sys
pkg_root, sdist = sys.argv[1], sys.argv[2]
sys.path.insert(0, pkg_root)
from generator import mavgen

out = os.path.join(pkg_root, "dialects", "v20")
os.makedirs(out, exist_ok=True)
xmls = sorted(glob.glob(os.path.join(sdist, "message_definitions", "v1.0", "*.xml")))
if not xmls:
    raise SystemExit("ERROR: no message_definitions found in sdist")

ok, failed = 0, []
for xml in xmls:
    name = os.path.splitext(os.path.basename(xml))[0]
    try:
        mavgen.mavgen(mavgen.Opts(os.path.join(out, name + ".py"),
                                  wire_protocol="2.0", language="Python",
                                  validate=False, error_limit=200), [xml])
        ok += 1
    except Exception as exc:                       # one bad dialect must not sink the payload
        failed.append("{0}: {1}".format(name, exc))

# Report on stderr so it survives the stdout redirect.
msg = "  {0}/{1} dialects generated".format(ok, len(xmls))
sys.stderr.write(msg + "\n")
for f in failed:
    sys.stderr.write("  FAILED {0}\n".format(f))

# ardupilotmega is the Pixhawk dialect: it is what carries GLOBAL_POSITION_INT
# and GPS_RAW_INT as gps.py imports them. Everything else is optional; this one
# is not, so its absence is a hard failure rather than a footnote in a log.
if not os.path.exists(os.path.join(out, "ardupilotmega.py")):
    raise SystemExit("ERROR: ardupilotmega.py missing - the Pixhawk dialect did not generate")
PY

# ---------------------------------------------------------------------------
# 5. pyserial (pure Python, ships ready to copy)
# ---------------------------------------------------------------------------
say "adding pyserial"
cp -r "$PS_DIR/serial" "$PKG/"

# ---------------------------------------------------------------------------
# 6. Prove every file parses as Python 3.6 before shipping it
# ---------------------------------------------------------------------------
say "verifying all files parse under Python 3.6 grammar"
python3 - "$PKG" <<'PY'
import ast, os, sys, tokenize
root = sys.argv[1]
bad = []
count = 0
for dirpath, _dirs, files in os.walk(root):
    for fn in files:
        if not fn.endswith(".py"):
            continue
        path = os.path.join(dirpath, fn)
        count += 1
        try:
            with open(path, "rb") as fh:
                ast.parse(fh.read(), filename=path, feature_version=(3, 6))
        except (SyntaxError, ValueError) as exc:
            bad.append("{0}: {1}".format(path, exc))

if bad:
    print("  {0} file(s) are NOT valid Python 3.6:".format(len(bad)))
    for b in bad[:10]:
        print("    " + b)
    raise SystemExit(1)
print("  all {0} modules parse as Python 3.6".format(count))
PY

# ---------------------------------------------------------------------------
# 7. Package
# ---------------------------------------------------------------------------
TMP_TAR="$(mktemp -t aeroshield_deps)"
tar czf "$TMP_TAR" -C "$WORK" pkg
mv "$TMP_TAR" "$OUT"

printf '\n  built %s (%s)\n' "$OUT" "$(du -h "$OUT" | cut -f1)"
printf '  next: make deps-drone\n\n'
