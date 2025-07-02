#!/bin/bash

# Emergency Queue Cleanup Script for Docker
# Clears all old bulk sync jobs from Redis queue

echo "🧹 Emergency Queue Cleanup for Stremlist"
echo "This will clear ALL jobs from the Redis queue to fix bulk sync issues"
echo ""

# Check if Docker is running
if ! docker info >/dev/null 2>&1; then
    echo "❌ Docker is not running. Please start Docker first."
    exit 1
fi

# Check if stremlist container is running
if ! docker ps | grep -q stremlist-app; then
    echo "❌ Stremlist container is not running."
    echo "Please start the application first with: docker-compose up -d"
    exit 1
fi

echo "🔍 Found running Stremlist container"
echo "🚀 Running queue cleanup..."
echo ""

# Run the cleanup script inside the Docker container
docker exec stremlist-app node scripts/cleanup_queue.js --force

echo ""
echo "✅ Queue cleanup completed!"
echo "📊 The application should now use the new staggered sync method."
echo ""
echo "💡 Monitor the logs to verify staggered sync is working:"
echo "   docker logs -f stremlist-app" 