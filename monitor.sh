#!/bin/bash
# Stremlist Monitoring Script

echo "========== Stremlist Monitoring =========="
echo "Date: $(date)"
echo ""

# Check if Docker is running
echo "Docker Status:"
if systemctl is-active docker >/dev/null 2>&1; then
    echo "✅ Docker is running"
else
    echo "❌ Docker is NOT running"
fi

# Check if Stremlist service is running
echo ""
echo "Stremlist Service Status:"
if systemctl is-active stremlist >/dev/null 2>&1; then
    echo "✅ Stremlist service is running"
else
    echo "❌ Stremlist service is NOT running"
fi

# Check if Nginx is running
echo ""
echo "Nginx Status:"
if systemctl is-active nginx >/dev/null 2>&1; then
    echo "✅ Nginx is running"
else
    echo "❌ Nginx is NOT running"
fi

# Check Nginx config validity
echo ""
echo "Nginx Config Check:"
nginx -t &> /tmp/nginx_test
if [ $? -eq 0 ]; then
    echo "✅ Nginx configuration is valid"
else
    echo "❌ Nginx configuration has errors:"
    cat /tmp/nginx_test
fi

# Check Docker Containers
echo ""
echo "Container Status:"
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

# Check Health Endpoint
echo ""
echo "Application Health Check:"
HEALTH_STATUS=$(curl -s http://localhost:7001/health)
echo "$HEALTH_STATUS" | grep -q "healthy" && echo "✅ Application is healthy" || echo "❌ Application health check failed"

# System Resources
echo ""
echo "System Resources:"
echo "Memory Usage:"
free -h

echo ""
echo "Disk Usage:"
df -h / | grep -v "Filesystem"

# Docker Stats (brief)
echo ""
echo "Container Resource Usage:"
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}\t{{.BlockIO}}"

# Redis Stats
echo ""
echo "Redis Info:"
echo -e "PING\r\nINFO memory\r\nINFO clients\r\nQUIT\r\n" | nc localhost 6379 | grep -E "used_memory_human|connected_clients"

echo ""
echo "========== End of Monitoring Report =========="
