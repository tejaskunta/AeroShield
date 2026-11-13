from pymavlink import mavutil
import time

master = mavutil.mavlink_connection('/dev/ttyACM0', baud=115200)

master.wait_heartbeat()
print("Pixhawk connected!")

while True:
    msg = master.recv_match(
        type=['GPS_RAW_INT', 'GPS2_RAW'],
        blocking=True,
        timeout=3
    )

    if msg is None:
        print("Waiting for GPS data...")
        continue

    print("\nMessage:", msg.get_type())

    if msg.get_type() in ['GPS_RAW_INT', 'GPS2_RAW']:
        print("Fix type:", msg.fix_type)
        print("Satellites:", msg.satellites_visible)
        print("Latitude:", msg.lat / 1e7)
        print("Longitude:", msg.lon / 1e7)
        print("HDOP:", msg.eph / 100.0)

    time.sleep(0.2)
