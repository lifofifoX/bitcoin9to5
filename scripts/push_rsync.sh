#!/bin/bash
set -euo pipefail

DEST="<remote user>@<remote ip>"
PORT="22"
DEST_DIR="/home/traderbot/bitcoin9to5"
LOCAL_DIR="/Users/<you>/ords/bitcoin9to5"

rsync -avz --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude .env \
  --exclude '*.tgz' \
  -e "ssh -p ${PORT}" \
  "${LOCAL_DIR}/" "${DEST}:${DEST_DIR}/"
ssh -p "${PORT}" "${DEST}" "cd ${DEST_DIR} && npm install && pm2 reload ecosystem.config.cjs || pm2 start ecosystem.config.cjs"
