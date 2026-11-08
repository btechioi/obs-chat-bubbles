#!/usr/bin/env bash
# Install / update the OBS chat-bubble overlay as a systemd user service.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/obs-chat-bubbles"
UNIT_DIR="$HOME/.config/systemd/user"

if ! command -v node >/dev/null 2>&1; then
  echo "node is required (Fedora: sudo dnf install nodejs)" >&2
  exit 1
fi

mkdir -p "$DEST" "$UNIT_DIR"

for item in server.js tts.js package.json package-lock.json public docs README.md; do
  [ -e "$SRC/$item" ] || continue
  rm -rf "${DEST:?}/$item"
  cp -a "$SRC/$item" "$DEST/$item"
done

if [ -d "$SRC/node_modules" ]; then
  rm -rf "${DEST:?}/node_modules"
  cp -a "$SRC/node_modules" "$DEST/node_modules"
else
  ( cd "$DEST" && npm install --omit=dev --no-audit --no-fund )
fi

cp "$SRC/systemd/obs-chat-bubbles.service" "$UNIT_DIR/obs-chat-bubbles.service"

systemctl --user daemon-reload
systemctl --user enable obs-chat-bubbles.service
systemctl --user restart obs-chat-bubbles.service
sleep 1
systemctl --user --no-pager status obs-chat-bubbles.service || true

echo
echo "Overlay:      http://127.0.0.1:4919/overlay?target=@BTech_IOI"
echo "Control panel: http://127.0.0.1:4919/"
echo "Installed in: $DEST"
