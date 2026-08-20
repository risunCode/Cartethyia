#!/bin/sh
# Prepare the persistent Railway data mount before dropping privileges.
set -eu
umask 077


# Railway mounts persistent volumes after the image filesystem is created, so
# the mount can be root-owned even though the image data directory is not.
mkdir -p /app/data
chown -R cartethyia:cartethyia /app/data
chmod 0700 /app/data

exec gosu cartethyia "$@"
