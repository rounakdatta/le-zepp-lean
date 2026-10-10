# LeZeppLean server for the homelab: CPU only, no GPU, no PyTorch.
#   docker build -t le-zepp-lean server/        (CI: .github/workflows/docker.yml)
# The models (~170 MB) download on first use into $LEZEPPLEAN_MODELS, so they live on
# the data volume, not in the image; mount it at /data.
FROM python:3.13-slim
LABEL org.opencontainers.image.source="https://github.com/rounakdatta/le-zepp-lean"

# yt-dlp needs a JavaScript runtime to read YouTube's player (without one: fewer formats
# and intermittent HTTP 403s). Node from Debian is enough.
RUN apt-get update \
 && apt-get install -y --no-install-recommends nodejs ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# The uv that wrote uv.lock (lockfile revision 5).
COPY --from=ghcr.io/astral-sh/uv:0.12 /uv /usr/local/bin/uv

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY lezepplean ./lezepplean

# /data is the volume in the cluster; created here too so a plain `docker run` works.
RUN useradd --create-home --uid 1000 lzl && mkdir -p /data && chown lzl /data
USER lzl

ENV PATH=/app/.venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    LEZEPPLEAN_DATA=/data \
    LEZEPPLEAN_MODELS=/data/models \
    LEZEPPLEAN_CAPTURES=/data/captures \
    LEZEPPLEAN_CAPTURE_AUDIO=0 \
    LEZEPPLEAN_THREADS=2
EXPOSE 8787
CMD ["uvicorn", "lezepplean.app:app", "--host", "0.0.0.0", "--port", "8787"]
