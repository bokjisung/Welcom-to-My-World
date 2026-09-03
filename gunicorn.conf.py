import os

bind = f"0.0.0.0:{os.environ.get('PORT', '8000')}"
worker_class = "gthread"
workers = 1
threads = max(2, int(os.environ.get("GABAE_THREADS", "4")))
timeout = 60
graceful_timeout = 30
keepalive = 5
accesslog = "-"
errorlog = "-"
capture_output = True
max_requests = 5000
max_requests_jitter = 500
