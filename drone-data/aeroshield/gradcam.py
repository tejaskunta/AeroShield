#!/usr/bin/env python3
"""
AeroShield - Grad-CAM explainability overlay (PRD section 5.1, Week 7).

A detection is a box and a number. That is not enough for a safety operator: when
the model says "anti-personnel mine, 0.81" they need to see *where in the frame the
model was looking* when it decided. Grad-CAM answers that — it back-propagates the
class score to the last convolutional layer and produces a heatmap of the pixels
that drove the decision. A tight blob over the object is evidence; a diffuse smear
or a highlight over the wrong thing is a false positive you can see before you task
an EOD team to it.

WHERE THIS RUNS
    On the training laptop / PC, NOT the Jetson Nano. It needs PyTorch and
    pytorch-grad-cam, and it runs a forward *and* a backward pass — the Nano has
    neither the libraries (jetson/README.md: no ultralytics, no PyTorch) nor the
    memory for a gradient pass. So this is a batch analysis over the frames that
    came off a flight, or a laptop running --detector ultralytics --gradcam. The
    TensorRT path on the drone cannot produce a heatmap at all, which is exactly
    why the overlay is uploaded to the backend separately (PUT
    /api/detections/{id}/gradcam) rather than computed inline.

WHAT THE HEATMAP MEANS — AND WHAT IT DOES NOT
    Grad-CAM shows which regions a linear combination of the final feature maps
    associates with the class. It is a *faithfulness signal*, not a proof. Two
    cautions baked into how we use it:
      * It is class-specific. We target the predicted class id, so the map explains
        "why anti-personnel mine", not "why something".
      * The overlay is advisory. A confident box with a heatmap over empty ground is
        a model the operator should distrust — but the box still stands until a
        human dismisses it. The overlay informs review; it never replaces it.

CLI — explain every detection in one image, writing one overlay per box:

    python3 jetson/gradcam.py --image frame.jpg --weights weights/best.pt \\
        --out-dir overlays/

The module is also importable by live_detect.py (--gradcam) and the uplink.

PYTHON 3.6+ (this file does not run on the Nano, so it is not held to the 3.6 rule).
Heavy imports (torch, pytorch_grad_cam, ultralytics) are lazy: importing this
module on a machine without them succeeds, and explainability() raises
GradCamUnavailable with the reason it cannot run, so callers skip explainability
and still ship the detection.
"""

from typing import List, Optional, Tuple

import cv2
import numpy as np


class GradCamUnavailable(Exception):
    """Raised when the explainability stack cannot run here (missing torch, etc.)."""


class GradCamSession(object):
    """Loads the weights once and explains many frames.

    Loading a YOLOv8 model is the expensive part (hundreds of MB, seconds on CPU),
    and both detection and attribution need the *same* weights — a heatmap from a
    different model than the one that drew the box would be a lie. So one session
    holds: the Ultralytics wrapper (for detect), the inner nn.Module (for Grad-CAM),
    and the target layer. Build it once, call detect()/explain() per frame.
    """

    def __init__(self, weights: Optional[str] = None, device: str = "cpu",
                 imgsz: int = 640, model=None) -> None:
        """`model` may be a preloaded Ultralytics YOLO object.

        Passing it lets live_detect.py reuse the weights its detector already
        loaded; loading a second copy would double the memory and, worse, risk a
        heatmap from a model that is not the one that drew the box. When omitted,
        the session loads `weights` itself (the CLI path).
        """
        try:
            from ultralytics import YOLO
        except ImportError as exc:  # pragma: no cover - environment dependent
            raise GradCamUnavailable(
                "ultralytics is not installed here. Grad-CAM runs on the training PC / "
                "laptop (see module docstring), not the Nano. pip install ultralytics."
            ) from exc
        try:
            import torch  # noqa: F401 - proves the runtime Grad-CAM needs exists
        except ImportError as exc:  # pragma: no cover - environment dependent
            raise GradCamUnavailable(
                "torch is not installed here; Grad-CAM runs on the training laptop, "
                "not the Nano. See jetson/README.md."
            ) from exc

        self.device = device
        self.imgsz = imgsz
        self._yolo = model if model is not None else YOLO(weights)
        # model.model is the underlying nn.Module; the Ultralytics wrapper is not one
        # and pytorch-grad-cam cannot walk it. eval(): a heatmap of a model in train
        # mode, with dropout and BN running stats off, would not describe the
        # detector that actually made the box.
        self._module = getattr(self._yolo, "model", None)
        if self._module is None:
            raise GradCamUnavailable(
                "Could not reach the underlying nn.Module from the YOLO object; "
                "pytorch-grad-cam needs it to hook the final convolution."
            )
        self._module.eval()
        self._target = self._pick_target_layer()
        self._cam = None  # built lazily; needs the torch import to have succeeded

    def _pick_target_layer(self):
        """The last convolutional layer in the neck.

        pytorch-grad-cam can find this itself, but naming the module lets a reviewer
        see which layer produced the map. For YOLOv8 the deepest Conv2d in module
        order is the neck feature every detection head reads from — the right thing
        to attribute.
        """
        import torch.nn as nn

        last_conv = None
        for module in self._module.modules():
            if isinstance(module, (nn.Conv2d, nn.ConvTranspose2d)):
                last_conv = module
        if last_conv is None:
            raise GradCamUnavailable("No convolutional layer found to attribute against.")
        return last_conv

    def _ensure_cam(self):
        """Build the GradCAM wrapper, or raise GradCamUnavailable with the reason.

        Every pytorch-grad-cam import lives behind this one funnel so the
        "stack missing -> graceful skip" contract holds no matter which part of
        the library is absent — a machine with the core package but a broken
        utils submodule must degrade, not traceback.
        """
        if self._cam is None:
            try:
                from pytorch_grad_cam import GradCAM
                from pytorch_grad_cam.utils.image import show_cam_on_image
                from pytorch_grad_cam.utils.model_targets import ClassifierOutputTarget
            except ImportError as exc:  # pragma: no cover - environment dependent
                raise GradCamUnavailable(
                    "pytorch-grad-cam is not installed (or incomplete): {0}. "
                    "pip install pytorch-grad-cam on the laptop that has the "
                    "weights, not on the drone.".format(exc)
                ) from exc
            self._show_cam = show_cam_on_image
            self._target_cls = ClassifierOutputTarget
            self._cam = GradCAM(model=self._module, target_layers=[self._target],
                                use_cuda=(self.device != "cpu"))
        return self._cam

    def detect(self, frame_bgr, conf: float = 0.25, iou: float = 0.45):
        """Return boxes as (x1,y1,x2,y2,class_id,confidence,class_name) in frame pixels.

        Ultralytics rescales back to the source image for us, so these coordinates
        line up with the frame that gets uploaded — the same pixels the dashboard shows.
        """
        results = self._yolo.predict(frame_bgr, conf=conf, iou=iou, imgsz=self.imgsz,
                                     device=self.device, verbose=False)
        boxes = []
        for r in results:
            for b in getattr(r, "boxes", []) or []:
                x1, y1, x2, y2 = [int(v) for v in b.xyxy[0].tolist()]
                cls = int(b.cls[0].item())
                name = r.names.get(cls, str(cls)) if hasattr(r, "names") else str(cls)
                boxes.append((x1, y1, x2, y2, cls, float(b.conf[0].item()), name))
        return boxes

    def explain(self, frame_bgr, boxes, top_k: int = 1) -> List[np.ndarray]:
        """One overlay per box (up to top_k), composited back to frame resolution.

        The overlay is aligned to boxes[i] so the caller uploads overlay[i] against
        detection[i]. Raises GradCamUnavailable if the stack cannot run — the caller
        must still ship the detection; a missing heatmap must never cost the record.
        """
        if not boxes:
            return []

        import torch

        cam = self._ensure_cam()  # also loads show_cam_on_image / target class

        # Preprocess to imgsz for the model; the composite is scaled back to the
        # source frame at the end so the wipe slider lines it up with the clean frame.
        rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        resized = cv2.resize(rgb, (self.imgsz, self.imgsz))
        tensor = torch.from_numpy(resized.transpose(2, 0, 1)).unsqueeze(0).to(self.device)

        overlays = []
        for (x1, y1, x2, y2, class_id, conf, name) in boxes[:top_k]:
            # Class-specific target. YOLO heads are not classification-logit models,
            # so ClassifierOutputTarget(class_id) is an approximation: it attributes
            # against the class channel rather than a single logit. This is the
            # standard, honest way to apply Grad-CAM to a detector and answers the
            # "where was it looking" question well enough for review. Documented, not
            # hidden, because a reviewer deserves to know the map is approximate.
            targets = [self._target_cls(class_id)]
            grayscale = cam(input_tensor=tensor, targets=targets, reshape=True)[0]

            combined = self._show_cam(resized, grayscale, use_rgb=True)
            out = cv2.cvtColor(combined, cv2.COLOR_RGB2BGR)
            full = cv2.resize(out, (frame_bgr.shape[1], frame_bgr.shape[0]))
            overlays.append(_draw_box(full, [(x1, y1, x2, y2, class_id, conf, name)]))
        return overlays


def _draw_box(image, boxes):
    """White box + label on an already-composited overlay (frame-scale coords)."""
    for (x1, y1, x2, y2, _cls, conf, name) in boxes:
        cv2.rectangle(image, (x1, y1), (x2, y2), (255, 255, 255), 2)
        cv2.putText(image, "{0} {1:.2f}".format(name, conf), (x1, max(15, y1 - 6)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 2)
    return image


def explainability(weights: str, frame_bgr, boxes, device: str = "cpu",
                   imgsz: int = 640, top_k: int = 1) -> List[np.ndarray]:
    """One-shot helper: build a session and explain. Raises GradCamUnavailable.

    Prefer GradCamSession when explaining many frames — this reloads the weights on
    every call. It exists so a caller with a single frame and no session management
    has a one-line entry point.
    """
    session = GradCamSession(weights, device=device, imgsz=imgsz)
    return session.explain(frame_bgr, boxes, top_k=top_k)


def encode_jpeg(image_bgr, quality: int = 85) -> Optional[bytes]:
    """JPEG-encode an overlay for upload. None on failure (never fatal)."""
    ok, buf = cv2.imencode(
        ".jpg", image_bgr, [int(cv2.IMWRITE_JPEG_QUALITY), int(quality)])
    return buf.tobytes() if ok else None


def main() -> int:
    import argparse
    import os

    ap = argparse.ArgumentParser(
        description="AeroShield Grad-CAM explainability over a single frame.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    ap.add_argument("--image", required=True, help="Frame to explain (jpg/png)")
    ap.add_argument("--weights", default="weights/best.pt", help="PyTorch weights (.pt)")
    ap.add_argument("--out-dir", default="gradcam_out", help="Where to write overlays")
    ap.add_argument("--device", default="cpu", help="'0' for GPU, 'cpu'")
    ap.add_argument("--conf", type=float, default=0.25)
    ap.add_argument("--iou", type=float, default=0.45)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--top-k", type=int, default=3,
                    help="Explain at most this many (highest-confidence) boxes")
    args = ap.parse_args()

    frame = cv2.imread(args.image)
    if frame is None:
        print("ERROR: could not read image {0}".format(args.image))
        return 1

    try:
        session = GradCamSession(args.weights, device=args.device, imgsz=args.imgsz)
        boxes = session.detect(frame, conf=args.conf, iou=args.iou)
    except GradCamUnavailable as exc:
        print("ERROR: {0}".format(exc))
        return 2

    print("detections : {0}".format(len(boxes)))
    if not boxes:
        print("no detections to explain")
        return 0

    try:
        overlays = session.explain(frame, boxes, top_k=args.top_k)
    except GradCamUnavailable as exc:
        print("overlays   : none ({0})".format(exc))
        return 0

    os.makedirs(args.out_dir, exist_ok=True)
    stem = os.path.splitext(os.path.basename(args.image))[0]
    for i, ov in enumerate(overlays):
        out = os.path.join(args.out_dir, "{0}_{1:02d}_gradcam.jpg".format(stem, i))
        cv2.imwrite(out, ov)
        print("overlay    : {0}".format(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
