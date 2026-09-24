#!/bin/sh
# Cartethyia container entrypoint
# Handles bind mount permission fixes and binary execution

set -e

# If running as root (UID 0), fix bind mount permissions to app user
# This handles cases where volumes are mounted with root ownership
if [ "$(id -u)" = "0" ]; then
  # Only chown if /app or critical subdirectories need fixing
  # Use find to efficiently target directories that need permission updates
  if [ -d "/app/migrations" ] && [ ! -w "/app/migrations" ]; then
    chown -R cartethyia:cartethyia /app
  fi
fi

# Execute the provided command (binary or shell command)
# Use exec to replace the entrypoint process, allowing signal propagation
exec "$@"
