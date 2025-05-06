# Stage 1: Use official Node.js 20 image
FROM node:20

# Set working directory inside the container
WORKDIR /usr/src/app

# Copy only package files first (helps with Docker layer caching)
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Now copy the rest of the application code
COPY . .

# Expose application port (optional, only if you're running an API or dashboard)
EXPOSE 3000

# Set the default command to start the bot
CMD ["node", "bot.js"]
