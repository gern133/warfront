#!/usr/bin/env bash
# Запуск Warfront на своей машине одной командой:
#   ./play.sh
#
# Что делает:
#   1. Поднимает игровой сервер (порт 8080), если он ещё не запущен.
#   2. Открывает бесплатный туннель cloudflare (чистый https, без страниц-
#      предупреждений, без лимита 60 минут) через порт 443 (--protocol http2,
#      т.к. дефолтный 7844 режется сетью).
#   3. Если публичный адрес сменился — прописывает его в GitHub Pages
#      (переменная VITE_WS_URL) и пере-деплоит клиент.
#   4. Печатает две ссылки: прямую (адрес туннеля) и на GitHub Pages.
#
# Останавливать: Ctrl+C (сервер и туннель гасятся автоматически).

set -euo pipefail
cd "$(dirname "$0")"

PORT=8080
CF_LOG="/tmp/warfront-cf.log"
SRV_LOG="/tmp/warfront-srv.log"
PAGES_URL="https://gern133.github.io/warfront/"

SRV_PID=""; CF_PID=""
cleanup() {
  echo ""
  echo "Останавливаю…"
  [ -n "$CF_PID" ]  && kill "$CF_PID"  2>/dev/null || true
  [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

# 1) Сервер
if curl -sS -m3 -o /dev/null "http://localhost:$PORT/" 2>/dev/null; then
  echo "✔ Сервер уже слушает :$PORT"
else
  echo "▶ Запускаю сервер…"
  nohup npm start > "$SRV_LOG" 2>&1 &
  SRV_PID=$!
  for i in $(seq 1 30); do
    curl -sS -m2 -o /dev/null "http://localhost:$PORT/" 2>/dev/null && break
    sleep 1
  done
  curl -sS -m2 -o /dev/null "http://localhost:$PORT/" 2>/dev/null \
    || { echo "✖ Сервер не поднялся, смотри $SRV_LOG"; exit 1; }
  echo "✔ Сервер запущен (pid $SRV_PID)"
fi

# 2) Туннель cloudflare
echo "▶ Открываю туннель cloudflare…"
pkill -f "cloudflared tunnel" 2>/dev/null || true
sleep 1
: > "$CF_LOG"
nohup cloudflared tunnel --protocol http2 --url "http://localhost:$PORT" > "$CF_LOG" 2>&1 &
CF_PID=$!

URL=""
for i in $(seq 1 30); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$CF_LOG" | head -1 || true)
  [ -n "$URL" ] && break
  sleep 1
done
[ -n "$URL" ] || { echo "✖ Туннель не дал адрес, смотри $CF_LOG"; cleanup; }
echo "✔ Туннель: $URL"

# 3) Синхронизация GitHub Pages, только если адрес сменился
WSS="wss://${URL#https://}"
CUR=$(gh variable list 2>/dev/null | awk '/VITE_WS_URL/{print $2}' || true)
if [ "$CUR" != "$WSS" ]; then
  echo "▶ Обновляю GitHub Pages на новый адрес…"
  gh variable set VITE_WS_URL --body "$WSS" >/dev/null
  gh workflow run deploy-pages.yml >/dev/null
  echo "✔ Pages пере-деплоится (~1–2 мин): $PAGES_URL"
else
  echo "✔ Адрес не менялся — Pages трогать не нужно: $PAGES_URL"
fi

echo ""
echo "──────────────────────────────────────────────"
echo "  Играть напрямую:  $URL"
echo "  Или через Pages:  $PAGES_URL"
echo "  (друзьям — любую из ссылок, без предупреждений)"
echo "──────────────────────────────────────────────"
echo "  Ctrl+C — остановить сервер и туннель."
echo ""

# Держим процесс живым, пока жив туннель
wait "$CF_PID"
