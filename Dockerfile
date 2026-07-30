FROM python:3.12-slim

WORKDIR /app
COPY requirements-stream.txt .
RUN pip install --no-cache-dir -r requirements-stream.txt

COPY stream_server.py .

ENV PORT=8765
ENV PYTHONUNBUFFERED=1
EXPOSE 8765

CMD ["sh", "-c", "gunicorn -b 0.0.0.0:${PORT:-8765} -w 2 --threads 4 --timeout 90 stream_server:app"]
