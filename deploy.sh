#!/bin/bash

# Load environment variables from .env file if it exists
if [ -f "/home/opc/imdb-watchlist-stremio/.env" ]; then
    source "/home/opc/imdb-watchlist-stremio/.env"
fi

# Set default values if environment variables are not set
PROJECT_ROOT=${PROJECT_ROOT:-"/home/opc/imdb-watchlist-stremio"}
DEPLOYMENT_LOG_FILE=${DEPLOYMENT_LOG_FILE:-"$PROJECT_ROOT/deployment.log"}
GITHUB_DEPLOY_KEY_PATH=${GITHUB_DEPLOY_KEY_PATH:-"/home/opc/.ssh/github_deploy_key"}
NOTIFICATION_EMAIL=${NOTIFICATION_EMAIL:-"lelemathrin69@gmail.com"}

# Mailgun settings - add these to your .env file with real values
MAILGUN_API_KEY=${MAILGUN_API_KEY:-"your-mailgun-api-key"}
MAILGUN_DOMAIN=${MAILGUN_DOMAIN:-"your-mailgun-domain"}
MAILGUN_FROM=${MAILGUN_FROM:-"Deployment <deployment@your-domain.com>"}

# Function to send email on deployment failure using Mailgun
send_failure_notification() {
    local error_message="$1"
    local hostname=$(hostname)
    local subject="[ALERT] Deployment Failed on $hostname"
    local body="Deployment failed on $hostname at $TIMESTAMP.\n\nError: $error_message\n\nSee $LOG_FILE for more details."
    
    # Use curl to send email via Mailgun API
    if command -v curl &> /dev/null; then
        curl -s --user "api:$MAILGUN_API_KEY" \
            https://api.mailgun.net/v3/$MAILGUN_DOMAIN/messages \
            -F from="$MAILGUN_FROM" \
            -F to="$NOTIFICATION_EMAIL" \
            -F subject="$subject" \
            -F text="$body" > /dev/null
        
        echo "[$TIMESTAMP] Failure notification sent to $NOTIFICATION_EMAIL using Mailgun" >> "$LOG_FILE"
    else
        echo "[$TIMESTAMP] WARNING: 'curl' command not found. Could not send email notification." >> "$LOG_FILE"
        echo "[$TIMESTAMP] Please install curl with: sudo dnf install curl" >> "$LOG_FILE"
        
        # Write to a notification file as a fallback
        local notification_file="$PROJECT_ROOT/deployment_failures.txt"
        echo -e "[$TIMESTAMP] DEPLOYMENT FAILURE\nHostname: $hostname\nError: $error_message\n" >> "$notification_file"
        echo "[$TIMESTAMP] Failure logged to $notification_file" >> "$LOG_FILE"
    fi
}

# Log file for deployment
LOG_FILE="$DEPLOYMENT_LOG_FILE"
TIMESTAMP=$(date "+%Y-%m-%d %H:%M:%S")

echo "[$TIMESTAMP] Starting deployment" >> "$LOG_FILE"
echo "[$TIMESTAMP] Using PROJECT_ROOT: $PROJECT_ROOT" >> "$LOG_FILE"
echo "[$TIMESTAMP] Using LOG_FILE: $LOG_FILE" >> "$LOG_FILE"
echo "[$TIMESTAMP] Using GITHUB_DEPLOY_KEY_PATH: $GITHUB_DEPLOY_KEY_PATH" >> "$LOG_FILE"
echo "[$TIMESTAMP] Using NOTIFICATION_EMAIL: $NOTIFICATION_EMAIL" >> "$LOG_FILE"

# Navigate to project directory
cd "$PROJECT_ROOT" || {
  error_msg="Failed to change directory to project folder"
  echo "[$TIMESTAMP] ERROR: $error_msg" >> "$LOG_FILE"
  send_failure_notification "$error_msg"
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
  error_msg="Git pull failed"
  echo "[$TIMESTAMP] ERROR: $error_msg" >> "$LOG_FILE"
  send_failure_notification "$error_msg"
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
  error_msg="Failed to restart stremlist service"
  echo "[$TIMESTAMP] ERROR: $error_msg" >> "$LOG_FILE"
  send_failure_notification "$error_msg"
  exit 1
fi

echo "[$TIMESTAMP] Deployment completed successfully" >> "$LOG_FILE"
exit 0
