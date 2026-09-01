# syntax=docker/dockerfile:1

# ONVIF PTZ proxy — one image, one process per camera (ADR-0004, ADR-0007).
# The proxy runs on the Node standard library only (no runtime dependencies),
# so the image is just the runtime plus `src/`. Per-instance binding arrives
# entirely through environment variables at container start (ADR-0006);
# nothing camera-specific is baked in here.

FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# The proxy has zero runtime dependencies (Node stdlib only), so nothing is
# installed in the image — just the manifest for metadata and `src/`.
COPY package.json ./
COPY src ./src

# Never run the listener as root inside the container.
USER node

# The documented in-container listen port; the actual port comes from
# LISTEN_PORT in the per-instance env_file (Compose must publish this port).
EXPOSE 8080

CMD ["node", "src/index.js"]
