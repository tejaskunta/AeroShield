
from pymavlink import mavutil
import time

PORT = "/dev/ttyACM0"
BAUD = 115200

print("Connecting to Pixhawk...")
master = mavutil.mavlink_connection(PORT, baud=BAUD)

if master.wait_heartbeat(timeout=30) is None:
    raise SystemExit("ERROR: Pixhawk heartbeat not received")

print("MAVLink connected!")

# Request position, GPS and attitude messages at 2 Hz
message_ids = [33, 24, 30]

for msg_id in message_ids:
    master.mav.command_long_send(
        master.target_system,
        master.target_component,
        mavutil.mavlink.MAV_CMD_SET_MESSAGE_INTERVAL,
        0,
        msg_id,
        500000,
        0, 0, 0, 0, 0
    )

last_print = 0

while True:
    msg = master.recv_match(
        type=["GPS_RAW_INT", "GLOBAL_POSITION_INT", "ATTITUDE"],
        blocking=True,
        timeout=2
    )

    if msg is None:
        print("Waiting for telemetry...")
        continue

    now = time.time()

    if msg.get_type() == "GPS_RAW_INT":
        print(
            f"GPS fix: {msg.fix_type}, "
            f"satellites: {msg.satellites_visible}"
        )

    elif msg.get_type() == "GLOBAL_POSITION_INT":
        if now - last_print >= 1:
            print(
                f"Lat: {msg.lat / 1e7:.7f}, "
                f"Lon: {msg.lon / 1e7:.7f}, "
                f"Altitude MSL: {msg.alt / 1000:.2f} m, "
                f"Relative altitude: "
                f"{msg.relative_alt / 1000:.2f} m, "
                f"Heading: {msg.hdg / 100:.2f} deg"
            )
            last_print = now

    elif msg.get_type() == "ATTITUDE":
        print(
            f"Roll: {msg.roll:.2f}, "
            f"Pitch: {msg.pitch:.2f}, "
            f"Yaw: {msg.yaw:.2f} rad"
        )

