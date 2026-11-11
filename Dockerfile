# =============================================================
# Salesforge CRM - Production Dockerfile
# Optimized for Node.js 22, Playwright Chromium, and Baileys WhatsApp Gateway
# =============================================================

FROM node:22-bookworm-slim

# Set non-interactive debian frontend and environment defaults
ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PORT=3000 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0

# Create working directory
WORKDIR /app

# Install system utilities and Playwright Chromium OS dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
    procps \
    && rm -rf /var/lib/apt/lists/*

# Copy package manifests first for optimal layer caching
COPY package*.json ./

# Install npm dependencies
RUN npm install --omit=dev

# Install Playwright Chromium and required OS shared libraries
RUN npx playwright install --with-deps chromium

# Copy application source code
COPY . .

# Create Baileys WhatsApp auth directory for session storage
RUN mkdir -p /app/baileys_auth_info

# Expose HTTP port
EXPOSE 3000

# Declare persistent volume for WhatsApp session keys
VOLUME ["/app/baileys_auth_info"]


# Healthcheck to monitor server responsiveness
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:3000/ || exit 1

# Start the CRM Server
CMD ["node", "backend/server.js"]
