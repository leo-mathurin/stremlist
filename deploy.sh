#!/bin/bash

# Load environment variables from .env file if it exists
if [ -f "/home/opc/imdb-watchlist-stremio/.env" ]; then
    source "/home/opc/imdb-watchlist-stremio/.env"
fi

# Set default values if environment variables are not set
PROJECT_ROOT=${PROJECT_ROOT:-"/home/opc/imdb-watchlist-stremio"}
DEPLOYMENT_LOG_FILE=${DEPLOYMENT_LOG_FILE:-"$PROJECT_ROOT/deployment.log"}
GITHUB_DEPLOY_KEY_PATH=${GITHUB_DEPLOY_KEY_PATH:-"/home/opc/.ssh/github_deploy_key"}

# Log file for deployment
LOG_FILE="$DEPLOYMENT_LOG_FILE"
TIMESTAMP=$(date "+%Y-%m-%d %H:%M:%S")

echo "[$TIMESTAMP] Starting deployment" >> "$LOG_FILE"
echo "[$TIMESTAMP] Using PROJECT_ROOT: $PROJECT_ROOT" >> "$LOG_FILE"
echo "[$TIMESTAMP] Using LOG_FILE: $LOG_FILE" >> "$LOG_FILE"
echo "[$TIMESTAMP] Using GITHUB_DEPLOY_KEY_PATH: $GITHUB_DEPLOY_KEY_PATH" >> "$LOG_FILE"

# Navigate to project directory
cd "$PROJECT_ROOT" || {
  echo "[$TIMESTAMP] ERROR: Failed to change directory to project folder" >> "$LOG_FILE"
  exit 1
}

# Use the deploy key for git operations
export GIT_SSH_COMMAND="ssh -i $GITHUB_DEPLOY_KEY_PATH -o IdentitiesOnly=yes"

# Get the current commit hash before pulling
BEFORE_PULL=$(git rev-parse HEAD)
echo "[$TIMESTAMP] Current commit before pull: $BEFORE_PULL" >> "$LOG_FILE"

# Pull latest changes
echo "[$TIMESTAMP] Pulling latest changes from git..." >> "$LOG_FILE"
if ! git pull; then
  echo "[$TIMESTAMP] ERROR: Git pull failed" >> "$LOG_FILE"
  exit 1
fi

# Get the current commit hash after pulling
AFTER_PULL=$(git rev-parse HEAD)
echo "[$TIMESTAMP] Current commit after pull: $AFTER_PULL" >> "$LOG_FILE"

# If the commit hash changed, show the changes
if [ "$BEFORE_PULL" != "$AFTER_PULL" ]; then
  echo "[$TIMESTAMP] Changes detected. Showing commit information:" >> "$LOG_FILE"
  # Show commits between the previous and current commit
  git log --pretty=format:"[$TIMESTAMP] %h - %s (%an, %ar)" $BEFORE_PULL..$AFTER_PULL >> "$LOG_FILE"
  echo "" >> "$LOG_FILE"
  
  # Show a summary of files changed
  echo "[$TIMESTAMP] Files changed:" >> "$LOG_FILE"
  git diff --name-status $BEFORE_PULL $AFTER_PULL >> "$LOG_FILE"
else
  echo "[$TIMESTAMP] No new commits were pulled" >> "$LOG_FILE"
fi

# Restart service
echo "[$TIMESTAMP] Restarting stremlist service..." >> "$LOG_FILE"
if ! sudo systemctl restart stremlist; then
  echo "[$TIMESTAMP] ERROR: Failed to restart stremlist service" >> "$LOG_FILE"
  exit 1
fi

echo "[$TIMESTAMP] Deployment completed successfully" >> "$LOG_FILE"
exit 0
