#!/bin/bash

# IMDb Watchlist Monitoring Script
# This script checks if the IMDb watchlist HTML scraping is working correctly 
# and reports the status to Better Stack

# IMDb watchlist URL (using HTML scraping approach)
IMDB_URL="https://www.imdb.com/user/ur195879360/watchlist/"

# Better Stack heartbeat URL
HEARTBEAT_URL="https://uptime.betterstack.com/api/v1/heartbeat/6xibJsfSf8Zoy7CowkA7BA7p"

# Log file path
LOG_FILE="/var/log/imdb_watchlist_monitor.log"

# Create log file directory if it doesn't exist
mkdir -p "$(dirname "$LOG_FILE")"

# Log start of check
echo "$(date): Starting IMDb watchlist HTML scraping check" >> "$LOG_FILE"

# Add random delay between 0-120 seconds (0-2 minutes) to avoid consistent timing patterns
RANDOM_DELAY=$((RANDOM % 120))
echo "$(date): Waiting for $RANDOM_DELAY seconds before making request" >> "$LOG_FILE"
sleep $RANDOM_DELAY

# Make request to IMDb watchlist page with a timeout of 30 seconds
RESPONSE=$(curl -s -w "\n%{http_code}" \
  -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36" \
  -H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8" \
  -H "Accept-Language: en-US,en;q=0.9" \
  -H "Accept-Encoding: gzip, deflate, br" \
  -H "Connection: keep-alive" \
  -H "Upgrade-Insecure-Requests: 1" \
  -H "Sec-Fetch-Dest: document" \
  -H "Sec-Fetch-Mode: navigate" \
  -H "Sec-Fetch-Site: none" \
  --compressed \
  --max-time 30 \
  "$IMDB_URL")

# Extract status code from response
HTTP_STATUS=$(echo "$RESPONSE" | tail -n1)
RESPONSE_BODY=$(echo "$RESPONSE" | sed '$d')

# Log response status
echo "$(date): Received HTTP status $HTTP_STATUS" >> "$LOG_FILE"

# Check if status code is 200 and response has expected structure
if [ "$HTTP_STATUS" -eq 200 ]; then
    # Check for private watchlist indicators
    if echo "$RESPONSE_BODY" | grep -qi "private list"; then
        ERROR_MESSAGE="Watchlist is private"
        echo "$(date): IMDb watchlist check failed. $ERROR_MESSAGE" >> "$LOG_FILE"
        curl -s -d "$ERROR_MESSAGE" "$HEARTBEAT_URL/fail" >> "$LOG_FILE" 2>&1
        echo "$(date): Failure reported to Better Stack" >> "$LOG_FILE"
    # Check for __NEXT_DATA__ script tag (required for our scraping approach)
    elif echo "$RESPONSE_BODY" | grep -q 'script.*id="__NEXT_DATA__"' && echo "$RESPONSE_BODY" | grep -q '"pageProps"'; then
        # Additional check for watchlist data structure
        if echo "$RESPONSE_BODY" | grep -q '"titleListItemSearch"' || echo "$RESPONSE_BODY" | grep -q '"predefinedList"'; then
            # Success - ping heartbeat URL
            echo "$(date): IMDb HTML scraping check successful, __NEXT_DATA__ found with watchlist data" >> "$LOG_FILE"
            curl -s "$HEARTBEAT_URL" >> "$LOG_FILE" 2>&1
            EXIT_CODE=$?
            if [ $EXIT_CODE -eq 0 ]; then
                echo "$(date): Heartbeat sent successfully" >> "$LOG_FILE"
            else
                echo "$(date): Failed to send heartbeat, exit code $EXIT_CODE" >> "$LOG_FILE"
            fi
        else
            ERROR_MESSAGE="__NEXT_DATA__ found but missing expected watchlist structure"
            echo "$(date): IMDb watchlist check failed. $ERROR_MESSAGE" >> "$LOG_FILE"
            curl -s -d "$ERROR_MESSAGE" "$HEARTBEAT_URL/fail" >> "$LOG_FILE" 2>&1
            echo "$(date): Failure reported to Better Stack" >> "$LOG_FILE"
        fi
    else
        ERROR_MESSAGE="__NEXT_DATA__ script tag not found in HTML response"
        echo "$(date): IMDb watchlist check failed. $ERROR_MESSAGE" >> "$LOG_FILE"
        curl -s -d "$ERROR_MESSAGE" "$HEARTBEAT_URL/fail" >> "$LOG_FILE" 2>&1
        echo "$(date): Failure reported to Better Stack" >> "$LOG_FILE"
    fi
else
    # Failure - construct error message
    ERROR_MESSAGE="Unexpected HTTP status code: $HTTP_STATUS"
    
    # Send failure heartbeat with error details
    echo "$(date): IMDb watchlist check failed. $ERROR_MESSAGE" >> "$LOG_FILE"
    curl -s -d "$ERROR_MESSAGE" "$HEARTBEAT_URL/fail" >> "$LOG_FILE" 2>&1
    
    echo "$(date): Failure reported to Better Stack" >> "$LOG_FILE"
fi

echo "$(date): IMDb watchlist HTML scraping check completed" >> "$LOG_FILE" 
