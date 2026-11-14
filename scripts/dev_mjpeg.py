#!/usr/bin/env python3
"""A stand-in for `jetson/stream.py`, so the camera path can be exercised here.

The live feed has one honest verification gap: the MJPEG stream only exists when
the aircraft is powered, booted and serving on :8080. So the browser-side of the
path -- the <img>, the Vite dev proxy, the `/jetson` rewrite, reconnect after a
drop, the "no signal" state and its recovery -- could not be tested without a
drone in front of you. This closes that gap. It speaks the same wire protocol as
the real thing (`multipart/x-mixed-replace; boundary=frame`, latest-frame-wins,
query string ignored), so a pass here is evidence about the *client* and not
about this script.

    python scripts/dev_mjpeg.py

then point the dev server at it instead of the aircraft:

    PowerShell:  $env:AEROSHIELD_JETSON_ORIGIN = "http://127.0.0.1:8080"
    sh:          AEROSHIELD_JETSON_ORIGIN=http://127.0.0.1:8080 npm run dev --prefix frontend

`vite.config.ts` reads that variable once at startup, so it must be set before the
dev server launches, and `VITE_JETSON_STREAM_URL=/jetson/stream` must already be
in `frontend/.env.local` for the feed to be mounted at all.

    python scripts/dev_mjpeg.py --frames-dir drone-data/aeroshield/jetson/spool

prefers real frames captured by the aircraft, cycling through them verbatim, so
the feed shows the actual payload rather than this script's synthetic pattern.
That directory is gitignored, so it is used opportunistically and the generated
pattern remains the default. Spool frames are real captures off the real camera,
which makes them the better eyeball test; the generated frames exist so that a
fresh clone works with nothing on disk and nothing installed.

WHAT THIS IS NOT
It is not a detector, and it bears no relation to `jetson/live_detect.py`. The red
box is painted by hand; there is no TensorRT, no camera and no flight. Its only
claim is that bytes arrive, in the right format, from the right port.
"""

import argparse
import math
import os
import socketserver
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

# Pillow is optional and is only ever a fast path. Everything here has a working
# pure-Python fallback, because a fresh clone of this repo has no virtualenv
# (AGENTS.md's interpreter table describes a machine that no longer exists) and a
# development tool that refuses to start is worse than a slow one. When present,
# Pillow encodes a 512x288 frame in ~4 ms instead of ~420 ms; the bytes are a
# baseline JPEG either way and the client cannot tell which path produced them.
try:
    from PIL import Image as _PIL_Image
except ImportError:
    _PIL_Image = None

HAVE_PIL = _PIL_Image is not None


# ---------------------------------------------------------------------------
# Baseline JPEG encoder
# ---------------------------------------------------------------------------
# Every frame served has to be a valid JPEG, and that is the one thing here worth
# being strict about: a malformed stream would look like a client bug and send
# someone debugging the wrong file.
#
# The tables below are ITU-T T.81 Annex K. They are given as BITS (how many codes
# of each length) plus the symbol list, and the actual code words are *derived*
# from them rather than written out by hand. Two reasons: the canonical
# assignment is then correct by construction, and a transcription slip fails loudly
# at import instead of producing a subtly corrupt image that only shows up as a
# grey smear in a browser.

# Zig-zag scan order: the natural-order index of each successive transmitted
# coefficient. Low frequencies first, which is what makes the end-of-block run
# worth compressing.
ZIGZAG = (
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
    12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
    58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
)

# Annex K.1 quantization tables, in natural (row-major) order.
LUMA_Q = (
    16, 11, 10, 16, 24, 40, 51, 61,
    12, 12, 14, 19, 26, 58, 60, 55,
    14, 13, 16, 24, 40, 57, 69, 56,
    14, 17, 22, 29, 51, 87, 80, 62,
    18, 22, 37, 56, 68, 109, 103, 77,
    24, 35, 55, 64, 81, 104, 113, 92,
    49, 64, 78, 87, 103, 121, 120, 101,
    72, 92, 95, 98, 112, 100, 103, 99,
)
CHROMA_Q = (
    17, 18, 24, 47, 99, 99, 99, 99,
    18, 21, 26, 66, 99, 99, 99, 99,
    24, 26, 56, 99, 99, 99, 99, 99,
    47, 66, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
)

# Annex K.3 Huffman tables, as (BITS, HUFFVAL).
DC_LUMA_SPEC = (
    (0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0),
    (0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11),
)
DC_CHROMA_SPEC = (
    (0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0),
    (0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11),
)
AC_LUMA_SPEC = (
    (0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 125),
    (
        0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06,
        0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xA1, 0x08,
        0x23, 0x42, 0xB1, 0xC1, 0x15, 0x52, 0xD1, 0xF0, 0x24, 0x33, 0x62, 0x72,
        0x82, 0x09, 0x0A, 0x16, 0x17, 0x18, 0x19, 0x1A, 0x25, 0x26, 0x27, 0x28,
        0x29, 0x2A, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3A, 0x43, 0x44, 0x45,
        0x46, 0x47, 0x48, 0x49, 0x4A, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
        0x5A, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6A, 0x73, 0x74, 0x75,
        0x76, 0x77, 0x78, 0x79, 0x7A, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
        0x8A, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9A, 0xA2, 0xA3,
        0xA4, 0xA5, 0xA6, 0xA7, 0xA8, 0xA9, 0xAA, 0xB2, 0xB3, 0xB4, 0xB5, 0xB6,
        0xB7, 0xB8, 0xB9, 0xBA, 0xC2, 0xC3, 0xC4, 0xC5, 0xC6, 0xC7, 0xC8, 0xC9,
        0xCA, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7, 0xD8, 0xD9, 0xDA, 0xE1, 0xE2,
        0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xF1, 0xF2, 0xF3, 0xF4,
        0xF5, 0xF6, 0xF7, 0xF8, 0xF9, 0xFA,
    ),
)
AC_CHROMA_SPEC = (
    (0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 119),
    (
        0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41,
        0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91,
        0xA1, 0xB1, 0xC1, 0x09, 0x23, 0x33, 0x52, 0xF0, 0x15, 0x62, 0x72, 0xD1,
        0x0A, 0x16, 0x24, 0x34, 0xE1, 0x25, 0xF1, 0x17, 0x18, 0x19, 0x1A, 0x26,
        0x27, 0x28, 0x29, 0x2A, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3A, 0x43, 0x44,
        0x45, 0x46, 0x47, 0x48, 0x49, 0x4A, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58,
        0x59, 0x5A, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6A, 0x73, 0x74,
        0x75, 0x76, 0x77, 0x78, 0x79, 0x7A, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
        0x88, 0x89, 0x8A, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9A,
        0xA2, 0xA3, 0xA4, 0xA5, 0xA6, 0xA7, 0xA8, 0xA9, 0xAA, 0xB2, 0xB3, 0xB4,
        0xB5, 0xB6, 0xB7, 0xB8, 0xB9, 0xBA, 0xC2, 0xC3, 0xC4, 0xC5, 0xC6, 0xC7,
        0xC8, 0xC9, 0xCA, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7, 0xD8, 0xD9, 0xDA,
        0xE2, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xF2, 0xF3, 0xF4,
        0xF5, 0xF6, 0xF7, 0xF8, 0xF9, 0xFA,
    ),
)


def _canonical(spec):
    """BITS + HUFFVAL -> {symbol: (code, length)}, per T.81 Annex C.

    Checks the structural invariants that a transcription slip would break: the
    counts must match the symbol list, no code may exceed its declared length,
    and no code may be a prefix of another (which the Kraft sum bounds).

    Deliberately NOT asserting that the table is complete. Annex K's DC tables
    are famously incomplete -- their Kraft sum is below one -- and decoders,
    including the ones in every browser, accept them because the unused code can
    simply never appear in the stream. An assertion of completeness here would
    reject the standard tables and send the next reader looking for a bug that is
    not there.
    """
    bits, values = spec
    total = sum(bits)
    if total != len(values):
        raise AssertionError(
            "Huffman table has {0} counts but {1} symbols".format(total, len(values))
        )
    table = {}
    code = 0
    k = 0
    for length in range(1, 17):
        for _ in range(bits[length - 1]):
            table[values[k]] = (code, length)
            code += 1
            k += 1
        code <<= 1
    for symbol, (code, length) in table.items():
        if length < 1 or length > 16 or code >= (1 << length):
            raise AssertionError(
                "symbol {0:#04x} has code {1:#x} which does not fit in {2} bits".format(
                    symbol, code, length
                )
            )
    # Prefix-freeness: a canonical code is prefix-free exactly when the Kraft
    # sum does not exceed one.
    kraft = sum(bits[length - 1] * (2.0 ** -length) for length in range(1, 17))
    if kraft > 1.0 + 1e-12:
        raise AssertionError("Huffman table is over-subscribed (Kraft {0})".format(kraft))
    return table


DC_LUMA = _canonical(DC_LUMA_SPEC)
DC_CHROMA = _canonical(DC_CHROMA_SPEC)
AC_LUMA = _canonical(AC_LUMA_SPEC)
AC_CHROMA = _canonical(AC_CHROMA_SPEC)

# Spot-checks against code words printed in T.81 and repeated in every reference
# decoder. These are the cheapest possible guard against a mistyped BITS array:
# the structural checks above would happily accept a table that is internally
# consistent but simply is not the standard's, whereas one wrong count shifts
# every subsequent code and these four comparisons all fail.
assert DC_LUMA[0] == (0b00, 2), "DC luma symbol 0"
assert DC_LUMA[5] == (0b110, 3), "DC luma symbol 5"
assert AC_LUMA[0x00] == (0b1010, 4), "AC luma end-of-block"
assert AC_CHROMA[0x00] == (0b00, 2), "AC chroma end-of-block"

# Forward DCT cosines, indexed [frequency][sample]. Hoisted out of the transform
# because it runs 64 times per block and `math.cos` is not free.
_COS = tuple(
    tuple(math.cos((2 * x + 1) * u * math.pi / 16.0) for x in range(8))
    for u in range(8)
)
# Orthonormal scale: 1/sqrt(2) at DC, 1 elsewhere. Combined with the 1/2 from each
# of the two 1-D passes, giving the usual 1/4 overall.
_C = tuple((1.0 / math.sqrt(2.0)) if u == 0 else 1.0 for u in range(8))


def _scaled_quant(table, quality):
    """Quality 1..100 -> a quantization table, per the usual Annex K scaling."""
    if quality < 1:
        quality = 1
    if quality > 100:
        quality = 100
    scale = 5000 // quality if quality < 50 else 200 - quality * 2
    out = []
    for v in table:
        q = (v * scale + 50) // 100
        out.append(min(255, max(1, q)))
    return tuple(out)


def _fdct(block):
    """2D DCT-II of an 8x8 block, row-major (row = y, col = x)."""
    # Pass 1: transform each row, leaving partial sums indexed [y][u].
    rows = []
    for y in range(8):
        base = y * 8
        row_out = []
        for u in range(8):
            cu = _COS[u]
            s = 0.0
            for x in range(8):
                s += block[base + x] * cu[x]
            row_out.append(s * _C[u] * 0.5)
        rows.append(row_out)
    # Pass 2: transform each column of the partial sums.
    out = [0.0] * 64
    for v in range(8):
        cv = _COS[v]
        vscale = _C[v] * 0.5
        for u in range(8):
            s = 0.0
            for y in range(8):
                s += rows[y][u] * cv[y]
            out[v * 8 + u] = s * vscale
    return out


def _category(value):
    """Bit length of |value|, which is the JPEG `ssss` magnitude category."""
    v = -value if value < 0 else value
    n = 0
    while v:
        v >>= 1
        n += 1
    return n


class _BitWriter(object):
    """MSB-first bit writer with JPEG's 0xFF byte stuffing."""

    __slots__ = ("buf", "acc", "nbits")

    def __init__(self):
        self.buf = bytearray()
        self.acc = 0
        self.nbits = 0

    def write(self, value, nbits):
        if nbits <= 0:
            return
        self.acc = (self.acc << nbits) | (value & ((1 << nbits) - 1))
        self.nbits += nbits
        while self.nbits >= 8:
            self.nbits -= 8
            byte = (self.acc >> self.nbits) & 0xFF
            self.buf.append(byte)
            if byte == 0xFF:
                # A 0xFF inside entropy-coded data must be followed by 0x00, or
                # the decoder reads it as the start of a marker segment.
                self.buf.append(0x00)
        self.acc &= (1 << self.nbits) - 1

    def flush(self):
        if self.nbits:
            # Pad with 1-bits, per T.81: they cannot be mistaken for a real code.
            self.write((1 << (8 - self.nbits)) - 1, 8 - self.nbits)
        return bytes(self.buf)


def _write_block(writer, plane, qtable, dc_table, ac_table, dc_pred):
    """Quantize, zig-zag and Huffman-code one 8x8 block. Returns the new DC value.

    `dc_pred` is the running predictor for this component and has to be carried
    across every block of the scan, because the decoder keeps its own and adds
    each difference to it. Resetting it per block would decode as a slowly
    drifting image rather than as an error, which is why it is threaded through
    explicitly instead of being closed over.
    """
    quant = [int(round(plane[i] / qtable[i])) for i in range(64)]

    diff = quant[0] - dc_pred
    cat = _category(diff)
    code, length = dc_table[cat]
    writer.write(code, length)
    if cat:
        # Negative values travel as the one's-complement of the low `cat` bits.
        # This is the "additional bits" rule, not two's complement.
        writer.write(diff if diff > 0 else diff + (1 << cat) - 1, cat)

    run = 0
    for k in range(1, 64):
        v = quant[ZIGZAG[k]]
        if v == 0:
            run += 1
            continue
        while run > 15:
            code, length = ac_table[0xF0]  # ZRL: sixteen zeros
            writer.write(code, length)
            run -= 16
        cat = _category(v)
        code, length = ac_table[(run << 4) | cat]
        writer.write(code, length)
        writer.write(v if v > 0 else v + (1 << cat) - 1, cat)
        run = 0
    if run:
        code, length = ac_table[0x00]  # EOB
        writer.write(code, length)
    return quant[0]


def _segment(marker, payload):
    """A JPEG marker segment: 0xFF, marker, then a big-endian 16-bit length."""
    return b"\xff" + bytes((marker,)) + (len(payload) + 2).to_bytes(2, "big") + payload


def _dht_payload():
    """Serialize the four tables as DHT definitions.

    Table ids follow baseline convention: 0x00 DC luma, 0x10 AC luma, 0x01 DC
    chroma, 0x11 AC chroma. Symbol order inside each definition is the order the
    canonical assignment consumes, so it comes from the reference HUFFVAL lists
    rather than from a dict, whose iteration order would silently differ.
    """
    payload = bytearray()
    for table_id, spec in (
        (0x00, DC_LUMA_SPEC),
        (0x10, AC_LUMA_SPEC),
        (0x01, DC_CHROMA_SPEC),
        (0x11, AC_CHROMA_SPEC),
    ):
        bits, values = spec
        payload.append(table_id)
        payload += bytes(bits)
        payload += bytes(values)
    return bytes(payload)


def encode_jpeg(rgb, width, height, device_quality=80, host_quality=65):
    """Encode an RGB byte string as a baseline JPEG, 4:4:4, no subsampling.

    `device_quality` scales the luma table and `host_quality` the chroma table.
    Splitting them is not a JPEG requirement, it is a preview compromise: the
    aircraft cares about the luminance detail a detector needs, while a person
    watching a moving feed notices colour blocking far less, so keeping chroma
    cheaper is most of the size win at this resolution.

    No subsampling keeps the marker segments simple and the decoder free of
    upsampling, at maybe 20 % more bytes. For a bench tool that is the right side
    of the trade.
    """
    if len(rgb) != width * height * 3:
        raise ValueError(
            "expected {0} bytes for {1}x{2} RGB, got {3}".format(
                width * height * 3, width, height, len(rgb)
            )
        )

    luma_q = _scaled_quant(LUMA_Q, device_quality)
    chroma_q = _scaled_quant(CHROMA_Q, host_quality)

    writer = _BitWriter()

    # One predictor per component, carried across the whole scan. See
    # `_write_block` for why this cannot be per-block.
    y_dc = 0
    cb_dc = 0
    cr_dc = 0

    # Edge blocks are padded by clamping to the last real pixel column or row,
    # which is why a size that is not a multiple of 8 still encodes correctly and
    # without stretching.
    for by in range(0, height, 8):
        for bx in range(0, width, 8):
            yb = [0.0] * 64
            cbb = [0.0] * 64
            crb = [0.0] * 64
            for row in range(8):
                yy = by + row
                if yy >= height:
                    yy = height - 1
                base = yy * width * 3
                for col in range(8):
                    xx = bx + col
                    if xx >= width:
                        xx = width - 1
                    i = base + xx * 3
                    r = rgb[i]
                    g = rgb[i + 1]
                    b = rgb[i + 2]
                    j = row * 8 + col
                    yb[j] = 0.299 * r + 0.587 * g + 0.114 * b - 128.0
                    cbb[j] = -0.168736 * r - 0.331264 * g + 0.5 * b
                    crb[j] = 0.5 * r - 0.418688 * g - 0.081312 * b
            y_dc = _write_block(writer, _fdct(yb), luma_q, DC_LUMA, AC_LUMA, y_dc)
            cb_dc = _write_block(writer, _fdct(cbb), chroma_q, DC_CHROMA, AC_CHROMA, cb_dc)
            cr_dc = _write_block(writer, _fdct(crb), chroma_q, DC_CHROMA, AC_CHROMA, cr_dc)

    entropy = writer.flush()

    out = bytearray()
    out += b"\xff\xd8"  # SOI
    out += _segment(0xE0, b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00")  # APP0

    dqt = bytearray()
    for table_id, table in ((0, luma_q), (1, chroma_q)):
        dqt.append(table_id)  # 8-bit precision, table id in the low nibble
        for k in range(64):
            dqt.append(table[ZIGZAG[k]])
    out += _segment(0xDB, bytes(dqt))

    # SOF0: baseline DCT, 8-bit samples, 3 components, all sampling factors 1x1.
    sof = bytearray((8, height >> 8, height & 0xFF, width >> 8, width & 0xFF, 3))
    for comp_id, sampling, qid in ((1, 0x11, 0), (2, 0x11, 1), (3, 0x11, 1)):
        sof += bytes((comp_id, sampling, qid))
    out += _segment(0xC0, bytes(sof))
    out += _segment(0xC4, _dht_payload())
    # SOS: three components, one interleaved scan, full spectral selection.
    out += _segment(0xDA, bytes((3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0)))
    out += entropy
    out += b"\xff\xd9"  # EOI
    return bytes(out)


def _encode_with_pil(rgb, width, height, quality):
    """Pillow's encoder, 4:4:4 so the output matches the hand-rolled path."""
    import io as _io

    if _PIL_Image is None:  # guard, so the failure names the actual problem
        raise RuntimeError("_encode_with_pil called without Pillow installed")
    image = _PIL_Image.frombytes("RGB", (width, height), rgb)
    out = _io.BytesIO()
    # subsampling=0 keeps 4:4:4, matching `encode_jpeg`'s choice. Without it
    # Pillow defaults to 4:2:0, which is smaller and visibly softer on the
    # hazard-red boxes, and the point of this tool is a feed that looks like the
    # aircraft's.
    image.save(out, format="JPEG", quality=quality, subsampling=0, optimize=False)
    return out.getvalue()


def encode_frame(rgb, width, height, quality):
    """Encode one frame, preferring Pillow and falling back to `encode_jpeg`."""
    if HAVE_PIL:
        return _encode_with_pil(rgb, width, height, quality)
    return encode_jpeg(
        rgb, width, height, device_quality=quality, host_quality=max(10, quality - 15)
    )


# ---------------------------------------------------------------------------
# Synthetic frames
# ---------------------------------------------------------------------------


def _hash(x, y, seed):
    """Cheap deterministic per-pixel noise, so no RNG is called per frame."""
    n = (x * 374761393 + y * 668265263 + seed * 2147483647) & 0xFFFFFFFF
    n = ((n ^ (n >> 13)) * 1274126177) & 0xFFFFFFFF
    return (n ^ (n >> 16)) & 0xFF


def _build_ground(width, height):
    """The parts of the frame that never change: ground, stripes, structures.

    Split out and cached because everything in here is tick-independent, and the
    per-pixel noise is by far the most expensive thing in this file. Recomputing
    it every frame cost about 48 ms at 512x288 for output that was byte-identical
    each time; computing it once and copying a bytearray costs under a millisecond.
    """
    buf = bytearray(width * height * 3)

    # The diagonal band. `abs((2y - x) - h/2) % period < 3` marks three
    # consecutive columns per row, so rather than testing every pixel this walks
    # to the first matching column and then steps by `period`.
    period = max(1, height // 3)
    centre = height // 2

    for y in range(height):
        row = y * width * 3
        for x in range(width):
            i = row + x * 3
            n = _hash(x, y, 3)
            buf[i] = 34 + (n >> 5)
            buf[i + 1] = 40 + (n >> 4)
            buf[i + 2] = 28 + (n >> 6)
        for k in range(3):
            x = (2 * y - centre - k) % period
            while x < width:
                i = row + x * 3
                buf[i] = 96
                buf[i + 1] = 94
                buf[i + 2] = 86
                x += period

    # Two rectangular structures, flat-toned so they survive quantization without
    # ringing and give the eye something with a straight edge to judge by.
    for ox, oy, w, h, tone in (
        (width // 8, height // 3, width // 5, height // 5, 118),
        (width // 2 + width // 10, height // 2, width // 6, height // 8, 140),
    ):
        for y in range(oy, min(oy + h, height)):
            for x in range(ox, min(ox + w, width)):
                i = (y * width + x) * 3
                buf[i] = tone
                buf[i + 1] = tone - 6
                buf[i + 2] = tone - 22

    return bytes(buf)


_GROUND_CACHE = {}


def _ground(width, height):
    key = (width, height)
    base = _GROUND_CACHE.get(key)
    if base is None:
        base = _build_ground(width, height)
        _GROUND_CACHE[key] = base
    return base


def render_frame(width, height, tick):
    """A dark, aerial-looking frame with a moving feature and a painted box.

    The moving element and the counter stripes exist so that a frozen or cached
    frame is obvious at a glance: if the box stops moving the feed is not live,
    and a stalled stream is the exact failure this tool exists to catch.
    """
    buf = bytearray(_ground(width, height))

    # The moving element: sweeps left to right while bobbing. High contrast,
    # because proving liveness is its whole job.
    cx = int((tick * 3) % max(1, width - 24)) + 12
    cy = height // 2 + int(math.sin(tick / 4.0) * (height / 5.0))
    for y in range(cy - 6, cy + 6):
        if 0 <= y < height:
            for x in range(cx - 6, cx + 6):
                if 0 <= x < width:
                    i = (y * width + x) * 3
                    buf[i] = 226
                    buf[i + 1] = 218
                    buf[i + 2] = 196

    # A detection box around it, hazard red, 2px stroke so it survives JPEG.
    bx, by, bw, bh = cx - 20, cy - 16, 40, 32
    for y in range(by, by + bh):
        if not (0 <= y < height):
            continue
        for x in range(bx, bx + bw):
            if not (0 <= x < width):
                continue
            if y < by + 2 or y >= by + bh - 2 or x < bx + 2 or x >= bx + bw - 2:
                i = (y * width + x) * 3
                buf[i] = 220
                buf[i + 1] = 56
                buf[i + 2] = 64

    # An eight-bit counter as stripes in the top-left corner: a stalled stream
    # shows as a still pattern, readable without squinting at a lone moving box.
    for bit in range(8):
        if (tick >> bit) & 1:
            for y in range(4, 12):
                if y >= height:
                    continue
                for x in range(4 + bit * 10, 4 + bit * 10 + 8):
                    if x < width:
                        i = (y * width + x) * 3
                        buf[i] = 245
                        buf[i + 1] = 243
                        buf[i + 2] = 239

    return bytes(buf)


# ---------------------------------------------------------------------------
# Frame source and publisher
# ---------------------------------------------------------------------------


class FrameSource(object):
    """Produces the next JPEG: stills from a directory, else generated frames."""

    def __init__(self, args):
        self.args = args
        self.tick = 0
        self.frames = []
        if args.frames_dir:
            try:
                names = sorted(
                    n for n in os.listdir(args.frames_dir)
                    if n.lower().endswith((".jpg", ".jpeg"))
                )
            except OSError as exc:
                sys.stderr.write("cannot read {0}: {1}\n".format(args.frames_dir, exc))
                names = []
            for name in names:
                try:
                    with open(os.path.join(args.frames_dir, name), "rb") as handle:
                        data = handle.read()
                except OSError:
                    continue
                # Only frames bracketed by SOI and EOI are used. The spool holds
                # rejects too, and serving a truncated capture would look like a
                # client bug -- the one thing this tool must not do.
                if data[:2] == b"\xff\xd8" and data[-2:] == b"\xff\xd9":
                    self.frames.append(data)
            if not self.frames:
                sys.stderr.write(
                    "no usable .jpg frames in {0} - using generated frames\n".format(
                        args.frames_dir
                    )
                )

    @property
    def mode(self):
        return "{0} stills".format(len(self.frames)) if self.frames else "generated"

    def next_jpeg(self):
        self.tick += 1
        if self.frames:
            return self.frames[self.tick % len(self.frames)]
        rgb = render_frame(self.args.width, self.args.height, self.tick)
        return encode_frame(rgb, self.args.width, self.args.height, self.args.quality)


class Publisher(object):
    """Holds the newest JPEG plus a sequence number. Latest frame wins.

    Same policy as `jetson/stream.py`: a slow viewer drops frames instead of
    making the producer wait, which is what keeps a preview from stalling the
    payload on the real aircraft.
    """

    def __init__(self, source, fps):
        self._source = source
        self._lock = threading.Lock()
        self._seq = 0
        self._jpeg = None
        self._stopped = False
        self._interval = 1.0 / max(1.0, float(fps))
        self._thread = threading.Thread(target=self._run, name="dev-mjpeg")
        self._thread.daemon = True

    def start(self):
        self._thread.start()

    def _run(self):
        while not self._stopped:
            started = time.time()
            jpeg = self._source.next_jpeg()
            with self._lock:
                self._jpeg = jpeg
                self._seq += 1
            elapsed = time.time() - started
            if elapsed < self._interval:
                time.sleep(self._interval - elapsed)

    def latest(self):
        with self._lock:
            return self._seq, self._jpeg

    def stop(self):
        self._stopped = True


PAGE = (
    b"<!doctype html><html><head><title>AeroShield stand-in feed</title></head>"
    b'<body style="margin:0;background:#111;color:#ddd;font:14px monospace">'
    b'<p style="padding:8px">Stand-in feed - not the aircraft. '
    b'<a style="color:#9cf" href="/stream">/stream</a></p>'
    b'<img src="/stream" style="width:100%"></body></html>'
)


def make_handler(publisher, mode, verbose):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            if verbose:
                sys.stderr.write("  %s %s\n" % (self.address_string(), fmt % args))

        def do_GET(self):
            # The query string is dropped deliberately. Browsers append
            # cache-busters when retrying an endless multipart request, and a
            # strict path comparison would answer those with a 404. This is the
            # same reasoning as the real `jetson/stream.py`, and matching it is
            # the point: a stand-in with different routing rules would hide
            # exactly the class of bug it exists to find.
            path = self.path.split("?", 1)[0]

            if path == "/":
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(PAGE)))
                self.end_headers()
                self.wfile.write(PAGE)
                return

            if path == "/health":
                body = (
                    '{"status":"ok","source":"dev-mjpeg","mode":"' + mode + '"}'
                ).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return

            if path != "/stream":
                self.send_error(404)
                return

            self.send_response(200)
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Pragma", "no-cache")
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            # No Content-Length: this response is unbounded by design, and
            # declaring one would make the browser wait for bytes that never come.
            self.send_header("Connection", "close")
            self.end_headers()

            last_seq = -1
            try:
                while True:
                    seq, jpeg = publisher.latest()
                    if jpeg is None or seq == last_seq:
                        time.sleep(0.01)
                        continue
                    last_seq = seq
                    self.wfile.write(b"--frame\r\n")
                    self.wfile.write(b"Content-Type: image/jpeg\r\n")
                    self.wfile.write(
                        "Content-Length: {0}\r\n\r\n".format(len(jpeg)).encode("ascii")
                    )
                    self.wfile.write(jpeg)
                    self.wfile.write(b"\r\n")
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                # A viewer navigating away is the normal end of this request.
                pass

    return Handler


class ThreadingHTTPServer(socketserver.ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Serve a stand-in MJPEG stream so the camera path is testable "
        "without the aircraft.",
    )
    parser.add_argument("--port", type=int, default=8080, help="default 8080, like the Jetson")
    parser.add_argument("--bind", default="127.0.0.1", help="default loopback only")
    parser.add_argument("--fps", type=float, default=10.0)
    parser.add_argument("--width", type=int, default=512)
    parser.add_argument("--height", type=int, default=288)
    parser.add_argument("--quality", type=int, default=80, help="JPEG quality 1-100")
    parser.add_argument(
        "--frames-dir",
        default=None,
        help="cycle JPEGs from this directory instead of generating frames",
    )
    parser.add_argument("--verbose", action="store_true", help="log each request")
    args = parser.parse_args(argv)

    if args.width % 8 or args.height % 8:
        # Not fatal -- edge blocks are padded by clamping -- but say so, because a
        # surprise size is usually a typo rather than an intention.
        sys.stderr.write(
            "note: width/height are not multiples of 8; edge blocks are padded\n"
        )

    source = FrameSource(args)
    publisher = Publisher(source, args.fps)
    publisher.start()

    server = ThreadingHTTPServer(
        (args.bind, args.port), make_handler(publisher, source.mode, args.verbose)
    )
    host, port = server.server_address[0], server.server_address[1]

    sys.stderr.write("dev-mjpeg: {0}, bound to {1}\n".format(source.mode, args.bind))
    sys.stderr.write(
        "  encoder {0}\n".format(
            "Pillow (fast)" if HAVE_PIL else "built-in (slow, no Pillow found)"
        )
    )
    sys.stderr.write("  page   http://{0}:{1}/\n".format(host, port))
    sys.stderr.write("  stream http://{0}:{1}/stream\n".format(host, port))
    sys.stderr.write(
        "  point the dev server here, before starting it:\n"
        "         AEROSHIELD_JETSON_ORIGIN=http://127.0.0.1:{0}\n".format(port)
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        sys.stderr.write("\nstopping\n")
    finally:
        publisher.stop()
        server.server_close()


if __name__ == "__main__":
    main()