# Multi-stage Dockerfile for Cicle Clone (Node.js + Prisma + PostgreSQL)
# Using Debian-based image (bookworm-slim) instead of Alpine for better Prisma compatibility
# (avoids OpenSSL/libssl detection issues and Prisma engine problems common on Alpine)
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Copy package files first (better layer caching)
COPY package*.json ./

# Install all dependencies
RUN npm ci

# Copy source
COPY . .

# Generate Prisma Client (does not require database connection)
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

# Make them available at runtime
ENV DATABASE_URL=$DATABASE_URL
ENV SESSION_SECRET=$SESSION_SECRET
ENV PORT=$PORT
ENV NODE_ENV=production

# Copy built artifacts from builder stage
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/src ./src
COPY --from=builder /app/prisma ./prisma

# Create non-root user and fix ownership so the nodejs user can run Prisma commands
# (Prisma sometimes needs to access/write engine files at runtime)
RUN groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 --gid nodejs nodejs && \
    chown -R nodejs:nodejs /app

USER nodejs

EXPOSE 3000

# Healthcheck using Node (no wget/curl dependency needed)
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e " \
    const http = require('http'); \
    const port = process.env.PORT || 3000; \
    const req = http.request({ hostname: 'localhost', port, path: '/', timeout: 2000 }, (res) => { \
      process.exit(res.statusCode < 500 ? 0 : 1); \
    }); \
    req.on('error', () => process.exit(1)); \
    req.end(); \
  "

# Apply Prisma schema to DB then start the app.
# Using 'db push' for MVP (no migration history yet). Switch to 'migrate deploy' after adding migrations.
CMD ["sh", "-c", "npx prisma db push && node src/app.js"]
