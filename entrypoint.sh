#!/bin/sh
# One image, two roles. Panels like Dokploy/Tiarina expose env vars but no
# command override, so the role is selected with SERVICE:
#   SERVICE=worker -> node worker/worker.mjs
#   anything else  -> node api/server.mjs (default; Render runs this)
# Any command passed by the platform (e.g. Render's dockerCommand) is
# ignored on purpose: SERVICE is the single source of truth.
set -e
if [ "$SERVICE" = "worker" ]; then
  echo "[entrypoint] starting worker"
  exec node worker/worker.mjs
else
  echo "[entrypoint] starting api"
  exec node api/server.mjs
fi
