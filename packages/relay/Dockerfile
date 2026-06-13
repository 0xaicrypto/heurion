# Nexus Email Relay — minimal Python image for Fly.io
FROM python:3.12-slim

WORKDIR /app

# Install deps first so the layer cache holds.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Audit DB lives in /data — mounted as a Fly volume so audit log
# survives redeploys. Created at runtime if absent.
RUN mkdir -p /data
VOLUME ["/data"]

COPY main.py .

ENV PORT=8443
ENV AUDIT_DB_PATH=/data/audit.db
EXPOSE 8443

# Single worker is fine — SMTP sends are I/O-bound, not CPU.
# Add more workers only if you measure CPU saturation.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8443"]
