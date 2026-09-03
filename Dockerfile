FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
RUN mkdir -p /app/data

# Railway Volumes are mounted as root. Running with the image default UID
# avoids write-permission failures on /data without an extra init wrapper.
EXPOSE 8000
CMD ["gunicorn", "-c", "gunicorn.conf.py", "app:app"]
