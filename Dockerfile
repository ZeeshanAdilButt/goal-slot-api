# Build stage
FROM node:24-alpine AS builder

WORKDIR /app

# Update npm and clear cache
RUN npm install -g npm@latest && npm cache clean --force

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies with retry. Using `npm install` instead of
# `npm ci` because the repo doesn't ship a package-lock.json (deleted
# in PR #17). Keeping the retry pattern in case the registry hiccups.
RUN npm install --no-audit --no-fund || (npm cache clean --force && npm install --no-audit --no-fund)

# Copy source code
COPY . .

# Generate Prisma Client. prisma.config.ts reads DATABASE_URL at
# config-parse time (env("DATABASE_URL") throws otherwise), so we pin
# a build-time placeholder. The real URL is injected at runtime by
# the platform (Render).
ENV DATABASE_URL="postgresql://stub:stub@localhost:5432/stub"
RUN npx prisma generate

# Build the application
RUN npm run build

# Production stage
FROM node:24-alpine AS production

WORKDIR /app

# Update npm and clear cache
RUN npm install -g npm@latest && npm cache clean --force

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install only production dependencies with retry. Using `npm install`
# instead of `npm ci` because the repo doesn't ship a package-lock.json
# (deleted in PR #17). `--omit=dev` keeps the image lean.
RUN npm install --omit=dev --no-audit --no-fund || (npm cache clean --force && npm install --omit=dev --no-audit --no-fund)

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
