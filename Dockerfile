# Multi-stage Dockerfile for Cicle Clone (Node.js + Prisma + PostgreSQL)
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev for prisma generate)
RUN npm ci

# Copy source
COPY . .

# Generate Prisma Client (does not require DB)
RUN npx prisma generate

# Production stage
FROM node:20-alpine

WORKDIR /app

# Accept build args from EasyPanel (they pass them via --build-arg)
ARG DATABASE_URL
ARG SESSION_SECRET
ARG PORT

# Set as environment variables for runtime
ENV DATABASE_URL=$DATABASE_URL
ENV SESSION_SECRET=$SESSION_SECRET
ENV PORT=$PORT
ENV NODE_ENV=production

# Copy from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/src ./src
COPY --from=builder /app/prisma ./prisma

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001
USER nodejs

EXPOSE 3000

# Simple healthcheck (use /health if you add the route later)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT:-3000}/ || exit 1

# Run Prisma migrations (or db push for early MVP) then start the app
# Using db push for now because migrations folder may be empty on first deploy
CMD ["sh", "-c", "npx prisma db push --accept-data-loss && node src/app.js"]
