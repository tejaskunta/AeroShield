"""Make jetson/ importable.

jetson/ is a plain directory of scripts, not an installed package - on the Nano it
is sys.path[0] because live_detect.py is run directly from there. Tests get the same
import surface by putting it on the path explicitly, so `import geo` resolves the
same way it does on the drone.
"""

import sys
from pathlib import Path

JETSON_DIR = Path(__file__).resolve().parent.parent / "jetson"

if str(JETSON_DIR) not in sys.path:
    sys.path.insert(0, str(JETSON_DIR))
