# Build stage
FROM node:24-bookworm-slim AS builder

WORKDIR /app

# Install system deps for Prisma (OpenSSL 3) and TLS
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Update npm and clear cache
RUN npm install -g npm@latest && npm cache clean --force

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies with retry
RUN npm ci || (npm cache clean --force && npm ci)

# Copy source code
COPY . .

# Generate Prisma Client
RUN npx prisma generate

# Build the application
RUN npm run build

# Production stage
FROM node:24-bookworm-slim AS production

WORKDIR /app

# Install system deps for Prisma (OpenSSL 3) and TLS
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Update npm and clear cache
RUN npm install -g npm@latest && npm cache clean --force

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install only production dependencies with retry
RUN npm ci --only=production || (npm cache clean --force && npm ci --only=production)

# Copy built application from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# Expose port
EXPOSE 4000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:4000/api/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start the application (migrations skipped - run manually)
CMD ["npm", "run", "start:prod"]
