# syntax=docker/dockerfile:1

# Secretary A-share assistant.
# This project has no compiled build step: it runs TypeScript directly via tsx.
# The default container process is the OFFLINE mock sentinel daemon, which only
# writes scheduler audit metadata and never touches real market data, LLM
# providers, broker adapters, or account files.

FROM node:20-slim

# OS timezone is cosmetic only; the app forces Asia/Shanghai internally via config.
ENV TZ=Asia/Shanghai

WORKDIR /app

# Install dependencies first for better layer caching.
# tsx lives in devDependencies, so install the full dependency set (do not prune dev).
COPY package.json package-lock.json ./
RUN npm ci

# Copy the rest of the project source.
COPY . .

# Run tsx as PID 1 so SIGTERM reaches the daemon directly for graceful shutdown.
# (The daemon listens for SIGINT/SIGTERM and stops the scheduler cleanly.)
CMD ["./node_modules/.bin/tsx", "scripts/dev/market-sentinel-daemon.ts"]
