FROM node:18-alpine

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy application code
COPY . .

# Expose the port the app runs on
EXPOSE 7001

# Set environment variables
ENV NODE_ENV=production

# Command to run the application
CMD ["node", "addon.js"] 