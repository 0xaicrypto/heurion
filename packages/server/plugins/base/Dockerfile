FROM python:3.11-slim

WORKDIR /app

RUN pip install --no-cache-dir \
    fastapi>=0.100 \
    uvicorn[standard]>=0.23 \
    python-docx>=1.1 \
    docxtpl>=0.6 \
    python-pptx>=0.6 \
    matplotlib>=3.8 \
    boto3>=1.28 \
    botocore

COPY plugin_server /app/plugin_server
COPY templates /templates

EXPOSE 8080

CMD ["uvicorn", "plugin_server.main:app", "--host", "0.0.0.0", "--port", "8080"]
