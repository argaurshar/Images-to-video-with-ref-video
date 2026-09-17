# Codespaces image. Kept separate from the deployment Dockerfile at the repo
# root because this one only needs the runtime; the source is mounted by
# Codespaces rather than copied in.
FROM python:3.11-slim

# opencv-python-headless links no GL at the pinned version; libglib is a cheap
# hedge because requirements.txt floats the minor version. ffmpeg is not
# installed on purpose: imageio-ffmpeg ships a static binary and every call in
# this app goes through it.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libglib2.0-0 git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspaces
