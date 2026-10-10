"""LeZeppLean server: identify a song from a watch mic clip and return time-synced lyrics."""

import os

# The image's tag, baked in when CI builds it (server/Dockerfile); "dev" anywhere else.
__version__ = os.environ.get("LEZEPPLEAN_VERSION", "dev")
