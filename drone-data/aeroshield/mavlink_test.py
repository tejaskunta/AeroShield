from pymavlink import mavutil

master = mavutil.mavlink_connection(
    '/dev/ttyACM0',
    baud=57600
)

print("Waiting for heartbeat...")
master.wait_heartbeat()

print("Pixhawk connected!")

while True:
    msg = master.recv_match(
        type='GPS_RAW_INT',
        blocking=True,
        timeout=5
    )

    if msg:
        print("Fix Type:", msg.fix_type)
        print("Satellites:", msg.satellites_visible)
        print("Latitude:", msg.lat / 1e7)
        print("Longitude:", msg.lon / 1e7)
        print("Altitude:", msg.alt / 1000)
        print("------------------------")
