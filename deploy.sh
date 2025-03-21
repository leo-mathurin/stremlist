#!/bin/bash

# Log file for deployment
LOG_FILE="/home/opc/deployment.log"
TIMESTAMP=$(date "+%Y-%m-%d %H:%M:%S")

echo "[$TIMESTAMP] Starting deployment" >> $LOG_FILE

# Navigate to project directory
cd /home/opc/imdb-watchlist-stremio || {
  echo "[$TIMESTAMP] ERROR: Failed to change directory to project folder" >> $LOG_FILE
  exit 1
}

# Pull latest changes
echo "[$TIMESTAMP] Pulling latest changes from git..." >> $LOG_FILE
if ! git pull; then
  echo "[$TIMESTAMP] ERROR: Git pull failed" >> $LOG_FILE
  exit 1
fi

# Restart service
echo "[$TIMESTAMP] Restarting stremlist service..." >> $LOG_FILE
if ! sudo systemctl restart stremlist; then
  echo "[$TIMESTAMP] ERROR: Failed to restart stremlist service" >> $LOG_FILE
  exit 1
fi

echo "[$TIMESTAMP] Deployment completed successfully" >> $LOG_FILE
exit 0
