#!/bin/bash
set -euo pipefail

DEST="<remote user>@<remote ip>"
PORT="22"
REMOTE_DIR="/home/traderbot/bitcoin9to5"
PM2_APP="cb-bot"

ssh -p "${PORT}" "${DEST}" "cd ${REMOTE_DIR} && pm2 logs ${PM2_APP} --lines 200"
