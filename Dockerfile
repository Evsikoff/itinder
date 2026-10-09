# Build the two embedded frontends; the station app uses plain browser modules.
FROM node:22-bookworm-slim AS portfolio-build
WORKDIR /build/portfolio
COPY portfolio-inner-site/package.json portfolio-inner-site/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY portfolio-inner-site/ ./
RUN GENERATE_SOURCEMAP=false npm run build

FROM node:22-bookworm-slim AS resume-build
WORKDIR /build/resume
COPY resume3/package.json resume3/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY resume3/ ./
RUN npm run build

FROM python:3.13-slim-bookworm AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOST=0.0.0.0 \
    PORT=8080 \
    APP_DATA_DIR=/data
WORKDIR /srv/itinder
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
COPY app/tools/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
COPY app/ ./app/
COPY assets/ ./assets/
COPY --from=portfolio-build /build/portfolio/build/ ./portfolio-inner-site/build/
COPY --from=resume-build /build/resume/public/ ./resume3/public/
RUN mkdir -p /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=4)"
CMD ["python", "app/tools/serve.py"]
