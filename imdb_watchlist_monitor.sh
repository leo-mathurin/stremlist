#!/bin/bash

# IMDb Watchlist Monitoring Script
# This script checks if the IMDb watchlist API is responding correctly 
# and reports the status to Better Stack

# IMDb API endpoint
IMDB_URL="https://api.graphql.imdb.com/?operationName=WatchListPageRefiner&variables=%7B%22first%22%3A10000%2C%22jumpToPosition%22%3A1%2C%22locale%22%3A%22en-US%22%2C%22sort%22%3A%7B%22by%22%3A%22LIST_ORDER%22%2C%22order%22%3A%22ASC%22%7D%2C%22urConst%22%3A%22ur195879360%22%7D&extensions=%7B%22persistedQuery%22%3A%7B%22sha256Hash%22%3A%2236d16110719e05e125798dec569721248a88835c64a7e853d3a80be8775eea92%22%2C%22version%22%3A1%7D%7D"

# Better Stack heartbeat URL
HEARTBEAT_URL="https://uptime.betterstack.com/api/v1/heartbeat/6xibJsfSf8Zoy7CowkA7BA7p"

# Log file path
LOG_FILE="/var/log/imdb_watchlist_monitor.log"

# Create log file directory if it doesn't exist
mkdir -p "$(dirname "$LOG_FILE")"

# Log start of check
echo "$(date): Starting IMDb watchlist check" >> "$LOG_FILE"

# Add random delay between 0-120 seconds (0-2 minutes) to avoid consistent timing patterns
RANDOM_DELAY=$((RANDOM % 120))
echo "$(date): Waiting for $RANDOM_DELAY seconds before making request" >> "$LOG_FILE"
sleep $RANDOM_DELAY

# Make request to IMDb API with a timeout of 30 seconds
RESPONSE=$(curl -s -w "\n%{http_code}" \
  -H "Content-Type: application/json" \
  -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36" \
  --max-time 30 \
  "$IMDB_URL")

# Extract status code from response
HTTP_STATUS=$(echo "$RESPONSE" | tail -n1)
RESPONSE_BODY=$(echo "$RESPONSE" | sed '$d')

# Log response status
echo "$(date): Received HTTP status $HTTP_STATUS" >> "$LOG_FILE"

# Check if status code is 200 and response has expected structure
if [ "$HTTP_STATUS" -eq 200 ] && echo "$RESPONSE_BODY" | grep -q '"data":{"predefinedList":'; then
    # Success - ping heartbeat URL
    echo "$(date): IMDb API check successful, sending heartbeat" >> "$LOG_FILE"
    curl -s "$HEARTBEAT_URL" >> "$LOG_FILE" 2>&1
    EXIT_CODE=$?
    if [ $EXIT_CODE -eq 0 ]; then
        echo "$(date): Heartbeat sent successfully" >> "$LOG_FILE"
    else
        echo "$(date): Failed to send heartbeat, exit code $EXIT_CODE" >> "$LOG_FILE"
    fi
else
    # Failure - construct error message
    if [ "$HTTP_STATUS" -ne 200 ]; then
        ERROR_MESSAGE="Unexpected HTTP status code: $HTTP_STATUS"
    else
        ERROR_MESSAGE="Response structure didn't match expected format"
    fi
    
    # Send failure heartbeat with error details
    echo "$(date): IMDb API check failed. $ERROR_MESSAGE" >> "$LOG_FILE"
    curl -s -d "$ERROR_MESSAGE" "$HEARTBEAT_URL/fail" >> "$LOG_FILE" 2>&1
    
    echo "$(date): Failure reported to Better Stack" >> "$LOG_FILE"
fi

echo "$(date): IMDb watchlist check completed" >> "$LOG_FILE" 
