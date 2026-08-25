#!/usr/bin/env bash
# Публикация игры: клиент на GitHub Pages, сервер — на этой машине через туннель.
#
#   npm run deploy                  # эфемерный адрес ngrok (умрёт при перезапуске)
#   NGROK_DOMAIN=my.ngrok-free.app npm run deploy    # постоянный адрес (так надо)
#
# Что делает:
#   1. Проверяет, что игровой сервер слушает :8080.
#   2. Поднимает ngrok на :8080 (если он ещё не поднят) и узнаёт публичный адрес.
#   3. Пишет его в переменную репозитория VITE_WS_URL (адрес вшивается в клиент
#      на этапе сборки, поэтому переменная, а не рантайм-конфиг).
#   4. Запускает workflow деплоя Pages, чтобы клиент пересобрался с новым адресом.
#
# Подробности и разбор «почему ссылка умирает» — docs/deploy.md
set -euo pipefail

REPO="${REPO:-gern133/warfront}"
PORT="${PORT:-8080}"
API="http://127.0.0.1:4040/api/tunnels"

say() { printf '\033[36m›\033[0m %s\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v gh >/dev/null || die "нужен gh CLI: brew install gh && gh auth login"
command -v ngrok >/dev/null || die "нужен ngrok: brew install ngrok && ngrok config add-authtoken <token>"

# 1. сервер
if ! lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  die "на :$PORT никто не слушает — сначала подними сервер: npm run build && npm start"
fi
say "сервер на :$PORT работает"

# 2. туннель
url=$(curl -fsS --max-time 3 "$API" 2>/dev/null \
  | python3 -c 'import sys,json;print(next((t["public_url"] for t in json.load(sys.stdin).get("tunnels",[]) if t.get("proto")=="https"),""))' 2>/dev/null || true)

if [ -z "$url" ]; then
  say "поднимаю ngrok…"
  if [ -n "${NGROK_DOMAIN:-}" ]; then
    nohup ngrok http "$PORT" --url="$NGROK_DOMAIN" --log=stdout >/tmp/ngrok-warfront.log 2>&1 &
  else
    nohup ngrok http "$PORT" --log=stdout >/tmp/ngrok-warfront.log 2>&1 &
  fi
  for _ in $(seq 1 30); do
    sleep 1
    url=$(curl -fsS --max-time 3 "$API" 2>/dev/null \
      | python3 -c 'import sys,json;print(next((t["public_url"] for t in json.load(sys.stdin).get("tunnels",[]) if t.get("proto")=="https"),""))' 2>/dev/null || true)
    [ -n "$url" ] && break
  done
  [ -n "$url" ] || die "ngrok не поднялся, смотри /tmp/ngrok-warfront.log"
else
  say "туннель уже поднят, переиспользую"
fi

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H 'ngrok-skip-browser-warning: 1' "$url" || true)
[ "$code" = "200" ] || die "туннель $url отвечает $code — сервер за ним недоступен"
say "туннель живой: $url"

# 3. переменная (wss:// — клиент подключается по защищённому WebSocket)
ws="wss://${url#https://}"
gh variable set VITE_WS_URL -R "$REPO" --body "$ws"
say "VITE_WS_URL = $ws"

# 4. пересборка клиента
gh workflow run deploy-pages.yml -R "$REPO"
say "деплой запущен, следить: gh run watch -R $REPO"
say "ссылка на игру: https://$(echo "$REPO" | cut -d/ -f1).github.io/$(echo "$REPO" | cut -d/ -f2)/"

if [ -z "${NGROK_DOMAIN:-}" ]; then
  printf '\n\033[33m!\033[0m Адрес ЭФЕМЕРНЫЙ: при перезапуске ngrok он сменится и ссылка снова умрёт.\n'
  printf '  Зарезервируй бесплатный домен (ngrok Dashboard → Domains) и запускай так:\n'
  printf '  NGROK_DOMAIN=<домен> npm run deploy\n'
fi
