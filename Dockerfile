# The app needs a real runtime: Python, ffmpeg and OpenCV's shared libraries.
# That is why it cannot run on GitHub Pages, which serves static files only.
FROM python:3.11-slim

# Deliberately no apt ffmpeg: imageio-ffmpeg ships its own static binary and
# every call in this app goes through imageio_ffmpeg.get_ffmpeg_exe(), so the
# distro package would be ~300MB of image for nothing. opencv-python-headless
# links no GL or glib at the pinned version; libglib2.0-0 is kept only as a
# cheap hedge because requirements.txt floats the opencv minor version.
RUN apt-get update && apt-get install -y --no-install-recommends libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ ./backend/
COPY frontend/ ./frontend/
COPY SPEC.md README.md ./

# Projects, renders, the project record and the saved API key live here.
# Without a mounted volume this is an ordinary directory inside the container,
# so it is wiped on restart; mount a volume on it for anything real.
ENV ARCHVIZ_DATA_DIR=/data
RUN mkdir -p /data && chmod 700 /data

ENV ARCHVIZ_PROVIDER=mock
EXPOSE 8000

# Single worker on purpose: the batch job registry lives in this process, so a
# second worker would not see a running job and could start a duplicate,
# paid-for batch. Scale with a bigger machine, not more workers.
CMD ["sh", "-c", "uvicorn backend.app.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1"]
