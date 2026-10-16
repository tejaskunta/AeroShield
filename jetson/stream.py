"""MJPEG-over-HTTP preview of the annotated frame. Stdlib only; Python 3.6 safe.

Serves / (a page with an <img>) and /stream (multipart JPEG). Latest-frame only:
a slow viewer drops frames instead of building a queue on the Nano.
"""

import socketserver
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import cv2

PAGE = b"""<!doctype html><html><head><title>AeroShield live</title></head>
<body style="margin:0;background:#111"><img src="/stream" style="width:100%"></body></html>"""


class FrameBroadcaster(object):
    def __init__(self, jpeg_quality=70):
        self._lock = threading.Lock()
        self._condition = threading.Condition(self._lock)
        self._jpeg = None
        self._seq = 0
        self._frame = None
        self._stopped = False
        self.jpeg_quality = jpeg_quality
        self._encoder = threading.Thread(target=self._encode_latest, name="mjpeg-encoder")
        self._encoder.daemon = True
        self._encoder.start()

    def publish(self, frame):
        with self._condition:
            self._frame = frame.copy()
            self._condition.notify()

    def _encode_latest(self):
        while True:
            with self._condition:
                while self._frame is None and not self._stopped:
                    self._condition.wait()
                if self._stopped:
                    return
                frame = self._frame
                self._frame = None

            ok, buf = cv2.imencode(
                ".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), self.jpeg_quality]
            )
            if not ok:
                continue
            with self._condition:
                self._jpeg = buf.tobytes()
                self._seq += 1

    def close(self):
        with self._condition:
            self._stopped = True
            self._condition.notify()
        self._encoder.join(1.0)

    def latest(self):
        with self._lock:
            return self._seq, self._jpeg


def make_handler(broadcaster):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            pass

        def do_GET(self):
            if self.path == "/":
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.send_header("Content-Length", str(len(PAGE)))
                self.end_headers()
                self.wfile.write(PAGE)
                return
            if self.path != "/stream":
                self.send_error(404)
                return

            self.send_response(200)
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.end_headers()
            last_seq = -1
            try:
                while True:
                    seq, jpeg = broadcaster.latest()
                    if jpeg is None or seq == last_seq:
                        time.sleep(0.02)
                        continue
                    last_seq = seq
                    self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\n")
                    self.wfile.write("Content-Length: {0}\r\n\r\n".format(len(jpeg)).encode("ascii"))
                    self.wfile.write(jpeg)
                    self.wfile.write(b"\r\n")
            except (BrokenPipeError, ConnectionResetError):
                pass
    return Handler


class ThreadingHTTPServer(socketserver.ThreadingMixIn, HTTPServer):
    daemon_threads = True


def start_server(port, broadcaster):
    """Run the HTTP server on a daemon thread. Returns the server for shutdown()."""
    server = ThreadingHTTPServer(("0.0.0.0", port), make_handler(broadcaster))
    t = threading.Thread(target=server.serve_forever, name="mjpeg-stream")
    t.daemon = True
    t.start()
    return server
