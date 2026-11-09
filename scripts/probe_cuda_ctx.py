#!/usr/bin/env python3
"""
SafeMine - one-shot CUDA context probe for the Jetson Nano.

WHY THIS EXISTS
---------------
The decoupled pipeline runs inference on a worker thread. A CUDA context is
current per-THREAD, so that worker has to attach the context that
``pycuda.autoinit`` created on the main thread. ``pipeline._current_cuda_context()``
used to do that with ``cuda.Context.get_current()`` only -- an API that does not
exist in the pycuda that JetPack 4.6 ships (2019.1.2). It returned ``None``, the
worker never attached, and the symptom was a SILENT hang: ``inferred 0``, no
traceback, no warning, and a 5 s join timeout that looked like slow inference.

This script answers, in one run and without touching the engine:

  1. which pycuda / TensorRT / CUDA versions are actually installed
  2. which context-acquisition APIs exist in THIS pycuda
  3. whether each one returns a usable context on the main thread
  4. whether that context can be pushed onto ANOTHER thread and used there
     (this is the exact operation the worker performs)
  5. whether a trivial memcpy on that other thread succeeds -- the cheapest
     possible proof that the attached context is real

Run it on the aircraft with the FLIGHT interpreter:

    make probe-cuda
    # equivalently:
    ssh jetson 'cd ~/aeroshield && PYTHONPATH=<cv2 paths> \\
        /usr/bin/python3.6 ../aeroshield/jetson/../scripts/probe_cuda_ctx.py'

Exit code 0 means at least one strategy attached a context to a worker thread
AND a memcpy on that thread succeeded. Non-zero means the decoupled path cannot
work as written and must be run single-threaded (``DECOUPLED=0``).

Python 3.6 safe: no f-strings with ``=``, no dataclasses, no ``from __future__``.
"""

import sys
import threading

OK = "  [ok]  "
WARN = "  [!!]  "
BAD = "  [XX]  "


def head(text):
    print("")
    print("--- {0} ".format(text) + "-" * max(0, 58 - len(text)))


def versions():
    """Report the exact stack. Version skew is the whole reason this bug existed."""
    head("Versions")
    print("{0}python : {1}".format(OK, sys.version.replace("\n", " ")))
    print("{0}exe    : {1}".format(OK, sys.executable))

    try:
        import pycuda
        print("{0}pycuda : {1}".format(OK, getattr(pycuda, "VERSION", "unknown")))
    except Exception as exc:                       # noqa: BLE001
        print("{0}pycuda : NOT IMPORTABLE ({1})".format(BAD, exc))
        return False

    try:
        import pycuda.driver as cuda
        print("{0}cuda   : {1}".format(OK, cuda.get_version()))
        print("{0}devices: {1}".format(OK, cuda.Device.count()))
        for i in range(cuda.Device.count()):
            d = cuda.Device(i)
            print("          [{0}] {1}  cc {2}.{3}  {4} MB".format(
                i, d.name(), d.compute_capability()[0], d.compute_capability()[1],
                d.total_memory() // (1024 * 1024)))
    except Exception as exc:                       # noqa: BLE001
        print("{0}cuda   : driver query failed ({1})".format(BAD, exc))

    try:
        import tensorrt as trt
        print("{0}tensorrt: {1}".format(OK, trt.__version__))
    except Exception as exc:                       # noqa: BLE001
        print("{0}tensorrt: NOT IMPORTABLE ({1})".format(WARN, exc))

    return True


def api_surface():
    """Which context-acquisition APIs does this pycuda actually have?

    `Context.get_current` landed in pycuda 2020.1; JetPack 4.6 ships 2019.1.2,
    so the presence flags below are the crux of the diagnosis.
    """
    import pycuda.driver as cuda

    head("API surface")
    has_get_current = hasattr(cuda.Context, "get_current")
    has_retain = hasattr(cuda, "retain_primary_context")
    has_autoinit = False
    try:
        import pycuda.autoinit   # noqa: F401
        has_autoinit = hasattr(sys.modules["pycuda.autoinit"], "context")
    except Exception as exc:                       # noqa: BLE001
        print("{0}pycuda.autoinit: failed ({1})".format(BAD, exc))

    print("{0}Context.get_current()      : {1}".format(
        OK if has_get_current else BAD, "present" if has_get_current else "MISSING"))
    print("{0}retain_primary_context()   : {1}".format(
        OK if has_retain else BAD, "present" if has_retain else "MISSING"))
    print("{0}pycuda.autoinit.context    : {1}".format(
        OK if has_autoinit else WARN, "present" if has_autoinit else "missing"))

    return has_get_current, has_retain, has_autoinit


def try_strategies(has_get_current, has_retain, has_autoinit):
    """Run each acquisition strategy on the MAIN thread and report the result."""
    import pycuda.driver as cuda

    head("Acquisition on the main thread")
    found = {}

    if has_get_current:
        try:
            ctx = cuda.Context.get_current()
            print("{0}get_current            -> {1!r}".format(OK, ctx))
            if ctx is not None:
                found["get_current"] = ctx
        except Exception as exc:                   # noqa: BLE001
            print("{0}get_current            -> raised {1}".format(BAD, exc))

    if has_autoinit:
        try:
            ctx = sys.modules["pycuda.autoinit"].context
            print("{0}autoinit.context       -> {1!r}".format(OK, ctx))
            if ctx is not None:
                found["autoinit"] = ctx
        except Exception as exc:                   # noqa: BLE001
            print("{0}autoinit.context       -> raised {1}".format(BAD, exc))

    if has_retain:
        try:
            ctx = cuda.retain_primary_context()
            print("{0}retain_primary_context -> {1!r}".format(OK, ctx))
            if ctx is not None:
                found["retain"] = ctx
        except Exception as exc:                   # noqa: BLE001
            print("{0}retain_primary_context -> raised {1}".format(BAD, exc))

    return found


def try_on_worker(name, ctx):
    """Push `ctx` on a fresh thread and do real device work there.

    This is precisely what DetectorThread does, so a success here means the
    decoupled design can work. A memcpy is used as the proof because it needs a
    live context and nothing else -- it is the cheapest true test.
    """
    import pycuda.driver as cuda

    result = {"pushed": False, "memcpy": False, "error": None}

    def body():
        try:
            ctx.push()
            result["pushed"] = True
        except Exception as exc:                   # noqa: BLE001
            result["error"] = "push: {0}".format(exc)
            return
        try:
            device = cuda.mem_alloc(1024)
            host = cuda.pagelocked_empty(256, dtype="float32")
            cuda.memcpy_htod(device, host)
            cuda.memcpy_dtoh(host, device)
            result["memcpy"] = True
        except Exception as exc:                   # noqa: BLE001
            result["error"] = "memcpy: {0}".format(exc)
        finally:
            try:
                device.free()
            except Exception:                      # noqa: BLE001
                pass
            try:
                ctx.pop()
            except Exception:                      # noqa: BLE001
                pass

    t = threading.Thread(target=body, name="probe-{0}".format(name))
    t.daemon = True
    t.start()
    # A hang here is the actual field failure, so bound the wait and say so
    # rather than blocking the operator's terminal forever.
    t.join(timeout=20.0)
    if t.is_alive():
        result["error"] = "TIMED OUT after 20 s (this is the field hang)"
        return False, result
    return result["pushed"] and result["memcpy"], result


def main():
    print("=" * 68)
    print("SafeMine CUDA context probe")
    print("=" * 68)

    if not versions():
        print("")
        print("pycuda is not importable with {0}.".format(sys.executable))
        print("The flight interpreter is /usr/bin/python3.6; run:")
        print("    make probe-cuda")
        return 2

    has_get_current, has_retain, has_autoinit = api_surface()
    candidates = try_strategies(has_get_current, has_retain, has_autoinit)

    if not candidates:
        print("")
        print("{0}No strategy produced a context on the main thread.".format(BAD))
        print("        Without one the TensorRT backend cannot run at all,")
        print("        decoupled or not. Re-run without --decoupled to confirm,")
        print("        then rebuild the engine with jetson/build_engine.sh.")
        return 1

    head("Cross-thread attach (the operation DetectorThread performs)")
    best = None
    for name in ("get_current", "autoinit", "retain"):
        if name not in candidates:
            continue
        works, result = try_on_worker(name, candidates[name])
        if works:
            print("{0}{1:22s} -> push + memcpy OK".format(OK, name))
            if best is None:
                best = name
        else:
            print("{0}{1:22s} -> {2}".format(BAD, name, result["error"]))

    print("")
    print("=" * 68)
    if best is not None:
        print("RESULT: usable via '{0}'".format(best))
        print("        pipeline._current_cuda_context() will use this strategy.")
        print("=" * 68)
        return 0

    print("RESULT: no strategy attached a context to another thread.")
    print("        Run the aircraft with DECOUPLED=0 (make run DECOUPLED=0)")
    print("        until this is resolved; the serial path keeps the CUDA")
    print("        context on the thread that created it.")
    print("=" * 68)
    return 1


if __name__ == "__main__":
    sys.exit(main())