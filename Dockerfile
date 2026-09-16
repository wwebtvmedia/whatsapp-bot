# Stage 1: Use official Node.js 20 image
# Fully qualified: podman refuses short names without unqualified-search-registries
FROM docker.io/library/node:20

# Set working directory inside the container
WORKDIR /usr/src/app

# Copy only package files first (helps with Docker layer caching)
COPY package*.json ./

# Install dependencies — npm ci honors the committed package-lock.json exactly
# (deterministic builds) and --omit=dev keeps nodemon & co out of the image.
# The lockfile pins patched versions via package.json "overrides" (npm audit: 0
# vulnerabilities in production deps).
RUN npm ci --omit=dev

# Now copy the rest of the application code
COPY . .

# Expose application port (optional, only if you're running an API or dashboard)
EXPOSE 3000

# Set the default command to start the bot
CMD ["node", "server.js"]
