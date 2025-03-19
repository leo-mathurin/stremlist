#!/bin/bash

# Development script for Stremlist

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Print banner
echo -e "${GREEN}"
echo "╔═══════════════════════════════════════╗"
echo "║           Stremlist Dev Tool          ║"
echo "╚═══════════════════════════════════════╝"
echo -e "${NC}"

# Parse command line arguments
REBUILD=false
CLEAN=false
REDIS_ONLY=false
NODE_ONLY=false
VERBOSE=false

for arg in "$@"
do
  case $arg in
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
      echo -e "Usage: ./dev.sh [options]"
      echo -e ""
      echo -e "Options:"
      echo -e "  --rebuild, -r       Force rebuild of containers"
      echo -e "  --clean, -c         Remove volumes and perform clean rebuild"
      echo -e "  --redis-only        Start only Redis container"
      echo -e "  --node-only         Start only Node.js container"
      echo -e "  --verbose, -v       Show verbose output"
      echo -e "  --help, -h          Show this help message"
      exit 0
      ;;
    *)
      # Unknown option
      echo -e "${RED}Unknown option: $arg${NC}"
      echo "Use --help to see available options"
      exit 1
      ;;
  esac
done

# Create development docker-compose file
cat > docker-compose.dev.yml << EOF
version: '3.8'

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
    restart: unless-stopped
    networks:
      - stremlist-network-dev
    command: npm run dev

networks:
  stremlist-network-dev:
    driver: bridge

volumes:
  redis-data-dev:
    driver: local
EOF

# Create development Dockerfile
cat > Dockerfile.dev << EOF
FROM node:18-alpine

WORKDIR /app

# Install development dependencies
COPY package*.json ./
RUN npm install

# Expose the port the app runs on
EXPOSE 7001

# Command to run the application is specified in docker-compose
CMD ["npm", "run", "dev"]
EOF

# Clean if requested
if [ "$CLEAN" = true ]; then
  echo -e "${YELLOW}Cleaning containers, images, and volumes...${NC}"
  docker-compose -f docker-compose.dev.yml down -v
  
  if [ "$VERBOSE" = true ]; then
    echo -e "${YELLOW}Removing development volumes...${NC}"
    docker volume rm stremlist-redis-data-dev 2>/dev/null || true
  fi
fi

# Build or start containers
if [ "$REBUILD" = true ]; then
  if [ "$REDIS_ONLY" = true ]; then
    echo -e "${GREEN}Rebuilding Redis container only...${NC}"
    docker-compose -f docker-compose.dev.yml up -d --build redis
  elif [ "$NODE_ONLY" = true ]; then
    echo -e "${GREEN}Rebuilding Node.js container only...${NC}"
    docker-compose -f docker-compose.dev.yml up -d --build app
  else
    echo -e "${GREEN}Rebuilding all containers...${NC}"
    docker-compose -f docker-compose.dev.yml up -d --build
  fi
else
  if [ "$REDIS_ONLY" = true ]; then
    echo -e "${GREEN}Starting Redis container only...${NC}"
    docker-compose -f docker-compose.dev.yml up -d redis
  elif [ "$NODE_ONLY" = true ]; then
    echo -e "${GREEN}Starting Node.js container only...${NC}"
    docker-compose -f docker-compose.dev.yml up -d app
  else
    echo -e "${GREEN}Starting all containers...${NC}"
    docker-compose -f docker-compose.dev.yml up -d
  fi
fi

# Display container status
echo -e "${GREEN}Container status:${NC}"
docker-compose -f docker-compose.dev.yml ps

# Show logs if not in redis-only mode
if [ "$REDIS_ONLY" != true ]; then
  echo -e "${GREEN}Showing logs for Node.js container (Ctrl+C to exit):${NC}"
  docker-compose -f docker-compose.dev.yml logs -f app
fi 