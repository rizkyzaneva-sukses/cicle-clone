# Multi-stage Dockerfile for Cicle Clone (Node.js + Prisma + PostgreSQL)
# Using Debian-based image (bookworm-slim) for better Prisma engine compatibility.
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Tell Prisma exactly which engine to download (prevents libssl/openssl auto-detection failures)
ENV PRISMA_CLI_BINARY_TARGETS=debian-openssl-3.0.x

# Copy package files first (better layer caching)
COPY package*.json ./

# Install all dependencies
RUN npm ci

# Copy source
COPY . .

# Generate Prisma Client
RUN npx prisma generate

# ==========================================
# Production / Runtime stage
# ==========================================
FROM node:20-bookworm-slim

WORKDIR /app

# Accept build args passed by EasyPanel
ARG DATABASE_URL
ARG SESSION_SECRET
ARG PORT

# Runtime environment
ENV DATABASE_URL=$DATABASE_URL
ENV SESSION_SECRET=$SESSION_SECRET
ENV PORT=$PORT
ENV NODE_ENV=production
ENV PRISMA_CLI_BINARY_TARGETS=debian-openssl-3.0.x

# Copy artifacts from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/src ./src
COPY --from=builder /app/prisma ./prisma

# Install OpenSSL (Prisma schema engine requires it)
# Do this BEFORE creating the non-root user
RUN apt-get update -y && \
    apt-get install -y openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Create non-root user + fix ownership (Prisma engines may need write access in some cases)
RUN groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 --gid nodejs nodejs && \
    chown -R nodejs:nodejs /app

USER nodejs

EXPOSE 3000

# Healthcheck (accepts redirects, only fails on 5xx or connection error)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e " \
    const http = require('http'); \
    const port = process.env.PORT || 3000; \
    const req = http.request({ hostname: 'localhost', port, path: '/', timeout: 2000 }, (res) => { \
      process.exit(res.statusCode < 500 ? 0 : 1); \
    }); \
    req.on('error', () => process.exit(1)); \
    req.end(); \
  "

# Run prisma db push with retries (DB may not be ready immediately in EasyPanel),
# then start the application.
CMD ["sh", "-c", "\
  for i in 1 2 3 4 5 6 7 8 9 10; do \
    echo \"Attempt $i: running prisma db push...\"; \
    npx prisma db push && break || \
    (echo \"Database not ready yet, waiting 4 seconds...\"; sleep 4); \
  done && \
  echo \"Starting application...\"; \
  node src/app.js"]

