#!/usr/bin/env bash
# Fallback dev S3 when Docker is unavailable: SeaweedFS (official release binary) inside WSL/Ubuntu.
# Usage (from Windows):  wsl -d Ubuntu -- bash scripts/dev/wsl-seaweedfs.sh start|stop|status
# Data lives in ~/.local/share/comparator-seaweedfs (outside the repo). S3 endpoint from Windows: http://localhost:8333
# (SeaweedFS binds [::]; WSL forwards it on "localhost", not on 127.0.0.1)
set -euo pipefail
VERSION="4.47"
ARCH="$(uname -m)"; case "$ARCH" in aarch64) ASSET=linux_arm64;; x86_64) ASSET=linux_amd64;; *) echo "unsupported arch $ARCH"; exit 1;; esac
BIN_DIR="$HOME/.local/seaweedfs-$VERSION"
DATA_DIR="$HOME/.local/share/comparator-seaweedfs"
S3_ACCESS_KEY="${S3_ACCESS_KEY_ID:-comparator}"
S3_SECRET_KEY="${S3_SECRET_ACCESS_KEY:-comparator_dev_secret}"

install() {
  [ -x "$BIN_DIR/weed" ] && return
  mkdir -p "$BIN_DIR"; cd "$BIN_DIR"
  curl -fsSLO "https://github.com/seaweedfs/seaweedfs/releases/download/$VERSION/$ASSET.tar.gz"
  curl -fsSLO "https://github.com/seaweedfs/seaweedfs/releases/download/$VERSION/$ASSET.tar.gz.md5"
  echo "$(cut -d' ' -f1 "$ASSET.tar.gz.md5")  $ASSET.tar.gz" | md5sum -c -
  tar xzf "$ASSET.tar.gz" && rm "$ASSET.tar.gz"
}

case "${1:-start}" in
  start)
    install
    mkdir -p "$DATA_DIR"
    cat > "$DATA_DIR/s3.json" <<JSON
{"identities":[{"name":"comparator","credentials":[{"accessKey":"$S3_ACCESS_KEY","secretKey":"$S3_SECRET_KEY"}],"actions":["Admin","Read","List","Tagging","Write"]}]}
JSON
    if pgrep -f "weed server -dir=$DATA_DIR" >/dev/null; then echo "already running"; exit 0; fi
    setsid nohup "$BIN_DIR/weed" server -dir="$DATA_DIR" -ip=127.0.0.1 -ip.bind=0.0.0.0 -master.volumeSizeLimitMB=1024 -volume.max=0 \
      -s3 -s3.port=8333 -s3.config="$DATA_DIR/s3.json" > "$DATA_DIR/weed.log" 2>&1 < /dev/null &
    for i in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:8333 && { echo "seaweedfs S3 up on :8333"; exit 0; }; sleep 1; done
    echo "seaweedfs did not start; see $DATA_DIR/weed.log"; exit 1;;
  stop) pkill -f "weed server -dir=$DATA_DIR" && echo stopped || echo "not running";;
  status) pgrep -af "weed server -dir=$DATA_DIR" || echo "not running";;
esac
