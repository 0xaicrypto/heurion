FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY stats_core.py main.py ./
EXPOSE 8005
CMD ["python", "main.py"]
