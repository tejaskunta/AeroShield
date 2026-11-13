#!/usr/bin/env python3
# Conservative coordinate association. Does NOT pretend aircraft GPS is the
# detected object's ground coordinate. Calibrated ray/terrain projection is a
# separate task requiring camera mounting pose and a validated ground model.

class CameraModel(object):
    def __init__(self, hfov_deg, image_width, image_height, vfov_deg=None):
        self.hfov_deg = float(hfov_deg)
        self.image_width = int(image_width)
        self.image_height = int(image_height)
        self.vfov_deg = vfov_deg


class GeoPosition(object):
    def __init__(self, lat, lon, horizontal_error_m=None):
        self.lat = float(lat)
        self.lon = float(lon)
        self.horizontal_error_m = horizontal_error_m


def bbox_to_latlon(camera, fix, x1, y1, x2, y2):
    """Return aircraft GPS position as a clearly-labelled map proxy.

    The current uploaded code does not provide a calibrated camera-to-ground
    projection. Returning the aircraft position is useful for associating a
    detection with its capture location, but is NOT an object ground position.
    """
    if fix is None:
        return None
    if not (-90.0 <= fix.lat <= 90.0 and -180.0 <= fix.lon <= 180.0):
        return None
    return GeoPosition(fix.lat, fix.lon, fix.horizontal_error_m)
