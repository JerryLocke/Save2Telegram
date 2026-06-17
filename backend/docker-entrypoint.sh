#!/bin/sh
set -eu

BOT_API_PID=""
BACKEND_PID=""

stop_children() {
  trap - INT TERM

  if [ -n "$BACKEND_PID" ] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID" 2>/dev/null || true
  fi

  if [ -n "$BOT_API_PID" ] && kill -0 "$BOT_API_PID" 2>/dev/null; then
    kill "$BOT_API_PID" 2>/dev/null || true
  fi

  if [ -n "$BACKEND_PID" ]; then
    wait "$BACKEND_PID" 2>/dev/null || true
  fi

  if [ -n "$BOT_API_PID" ]; then
    wait "$BOT_API_PID" 2>/dev/null || true
  fi
}

wait_for_bot_api() {
  url="$1"
  wait_seconds="${TELEGRAM_BOT_API_WAIT_SECONDS:-30}"
  waited=0

  while [ "$waited" -lt "$wait_seconds" ]; do
    if node -e "const c = new AbortController(); setTimeout(() => c.abort(), 1000); fetch(process.argv[1], { signal: c.signal }).then(() => process.exit(0), () => process.exit(1));" "$url"; then
      return 0
    fi

    if ! kill -0 "$BOT_API_PID" 2>/dev/null; then
      set +e
      wait "$BOT_API_PID"
      status="$?"
      set -e
      echo "Embedded Telegram Bot API server exited early with status $status." >&2
      exit "$status"
    fi

    waited=$((waited + 1))
    sleep 1
  done

  echo "Embedded Telegram Bot API server did not become ready at $url within ${wait_seconds}s." >&2
  exit 1
}

if [ -n "${TELEGRAM_API_ID:-}" ] || [ -n "${TELEGRAM_API_HASH:-}" ]; then
  if [ -z "${TELEGRAM_API_ID:-}" ] || [ -z "${TELEGRAM_API_HASH:-}" ]; then
    echo "Both TELEGRAM_API_ID and TELEGRAM_API_HASH are required to start the embedded Telegram Bot API server." >&2
    exit 1
  fi

  bot_api_host="${TELEGRAM_BOT_API_HOST:-127.0.0.1}"
  bot_api_port="${TELEGRAM_BOT_API_PORT:-8081}"
  bot_api_dir="${TELEGRAM_BOT_API_DIR:-/var/lib/telegram-bot-api}"
  bot_api_url="http://${bot_api_host}:${bot_api_port}"

  mkdir -p "$bot_api_dir"
  export TELEGRAM_API_BASE="${TELEGRAM_API_BASE:-$bot_api_url}"

  echo "Starting embedded Telegram Bot API server on ${bot_api_host}:${bot_api_port}."
  telegram-bot-api \
    --local \
    --dir="$bot_api_dir" \
    --http-ip-address="$bot_api_host" \
    --http-port="$bot_api_port" \
    ${TELEGRAM_BOT_API_ARGS:-} &
  BOT_API_PID="$!"

  wait_for_bot_api "$bot_api_url"
  echo "Embedded Telegram Bot API server is ready."
fi

if [ -z "$BOT_API_PID" ]; then
  exec node server.js "$@"
fi

trap 'stop_children; exit 143' INT TERM

node server.js "$@" &
BACKEND_PID="$!"

set +e
wait "$BACKEND_PID"
backend_status="$?"
set -e

stop_children
exit "$backend_status"
