# bitcoin9to5

Minimal 10am slam bot

## Requirements

- Node.js

## Install

```bash
npm install
```

## Run

```bash
node bot.js
```

## Env vars

- `CB_API_KEY`
- `CB_API_SECRET`

```bash
CB_API_KEY="..." CB_API_SECRET="..." node bot.js
```

## Scripts

- `scripts/push_rsync.sh`: rsync this project to a remote server and restart the pm2 process
- `scripts/remote_logs.sh`: tail pm2 logs on the remote server
