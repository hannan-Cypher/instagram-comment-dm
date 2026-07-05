# ─────────────────────────────────────────────────
# Dockerfile — Instagram Comment-to-DM
# ─────────────────────────────────────────────────
# Single-stage build. Installs deps, generates Prisma client,
# runs the Express server.
#
# Why single-stage? The production image is ~250MB either way
# (Node runtime dominates). Multi-stage adds complexity for
# negligible savings with this app size.

FROM node:20-slim

WORKDIR /app

# Copy dependency manifests
COPY package.json package-lock.json* ./

# Install all dependencies (devDeps needed for prisma generate at build time)
# The postinstall script runs prisma generate automatically
RUN npm install

# Copy application code
COPY . .

# Run as non-root user for security
USER node

EXPOSE 3000

CMD ["node", "src/index.js"]
