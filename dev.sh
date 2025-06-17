#!/bin/bash

# Development script for Stremlist

# Print banner
echo
echo "======================================="
echo "           Stremlist Dev Tool"
echo "======================================="
echo

# Initialize variables
REBUILD=false
CLEAN=false
REDIS_ONLY=false
NODE_ONLY=false
VERBOSE=false

# Function to show help
show_help() {
    echo "Usage: dev.sh [options]"
    echo
    echo "Options:"
    echo "  --rebuild, -r       Force rebuild of containers"
    echo "  --clean, -c         Remove volumes and perform clean rebuild"
    echo "  --redis-only        Start only Redis container"
    echo "  --node-only         Start only Node.js container"
    echo "  --verbose, -v       Show verbose output"
    echo "  --help, -h          Show this help message"
    exit 0
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --rebuild|-r)
            REBUILD=true
            shift
            ;;
        --clean|-c)
            CLEAN=true
            shift
            ;;
        --redis-only)
            REDIS_ONLY=true
            shift
            ;;
        --node-only)
            NODE_ONLY=true
            shift
            ;;
        --verbose|-v)
            VERBOSE=true
            shift
            ;;
        --help|-h)
            show_help
            ;;
        *)
            echo "Unknown option: $1"
            echo "Use --help to see available options"
            exit 1
            ;;
    esac
done

# Create development docker-compose file
echo "Creating development configuration files..."
cat > docker-compose.dev.yml << 'EOF'
services:
  # Redis service
  redis:
    image: redis:7.0-alpine
    container_name: stremlist-redis-dev
    ports:
      - "6379:6379"
    volumes:
      - redis-data-dev:/data
    command: redis-server --appendonly yes
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 5
    networks:
      - stremlist-network-dev

  # Application service for development
  app:
    build:
      context: .
      dockerfile: Dockerfile.dev
    container_name: stremlist-app-dev
    volumes:
      - .:/app
      - /app/node_modules
    environment:
      - NODE_ENV=development
      - REDIS_URL=redis://redis:6379
      - REDIS_ENABLED=true
      - USE_MEMORY_FALLBACK=true
      - VERBOSE=true
      - SYNC_INTERVAL=30
      - CACHE_TTL=15
      - WORKER_CONCURRENCY=2
      - WORKER_ENABLED=true
      - PORT=7001
    ports:
      - "7001:7001"
    depends_on:
      redis:
        condition: service_healthy
    restart: on-failure:3
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:7001/health"]
      interval: 10s
      timeout: 10s
      retries: 3
      start_period: 15s
    networks:
      - stremlist-network-dev
    command: ["npm", "run", "dev"]

networks:
  stremlist-network-dev:
    driver: bridge

volumes:
  redis-data-dev:
    driver: local
EOF

# Create development Dockerfile
cat > Dockerfile.dev << 'EOF'
FROM node:18-alpine

WORKDIR /app

# Install development dependencies and wget for healthcheck
RUN apk add --no-cache wget

# Copy package files and install both regular and dev dependencies
COPY package*.json ./
RUN npm install --include=dev

# Install nodemon globally to ensure it's in PATH
RUN npm install -g nodemon

# Expose the port the app runs on
EXPOSE 7001

# Command to run the application is specified in docker-compose
CMD ["npm", "run", "dev"]
EOF

# Clean if requested
if [ "$CLEAN" = true ]; then
    echo "Cleaning containers, images, and volumes..."
    docker-compose -f docker-compose.dev.yml down -v
    
    if [ "$VERBOSE" = true ]; then
        echo "Removing development volumes..."
        docker volume rm stremlist-redis-data-dev 2>/dev/null || echo "Volume not found"
    fi
fi

# Build or start containers
if [ "$REBUILD" = true ]; then
    if [ "$REDIS_ONLY" = true ]; then
        echo "Rebuilding Redis container only..."
        docker-compose -f docker-compose.dev.yml up -d --build redis
    elif [ "$NODE_ONLY" = true ]; then
        echo "Rebuilding Node.js container only..."
        docker-compose -f docker-compose.dev.yml up -d --build app --force-recreate
    else
        echo "Rebuilding all containers..."
        docker-compose -f docker-compose.dev.yml up -d --build --force-recreate
    fi
else
    if [ "$REDIS_ONLY" = true ]; then
        echo "Starting Redis container only..."
        docker-compose -f docker-compose.dev.yml up -d redis
    elif [ "$NODE_ONLY" = true ]; then
        echo "Starting Node.js container only..."
        docker-compose -f docker-compose.dev.yml up -d app
    else
        echo "Starting all containers..."
        docker-compose -f docker-compose.dev.yml up -d
    fi
fi

# Display container status
echo "Container status:"
docker-compose -f docker-compose.dev.yml ps

# Show logs if not in redis-only mode
if [ "$REDIS_ONLY" != true ]; then
    echo "Showing logs for Node.js container (Ctrl+C to exit):"
    docker-compose -f docker-compose.dev.yml logs -f app
fi 