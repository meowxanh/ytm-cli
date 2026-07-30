FROM python:3.12-slim

# ffmpeg optional but helps some formats
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements-stream.txt .
RUN pip install --no-cache-dir -r requirements-stream.txt \
  && pip install --no-cache-dir -U yt-dlp

COPY stream_server.py .

ENV PORT=8765
ENV PYTHONUNBUFFERED=1
EXPOSE 8765

CMD ["sh", "-c", "gunicorn -b 0.0.0.0:${PORT:-8765} -w 2 --threads 4 --timeout 120 stream_server:app"]
