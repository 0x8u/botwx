#!/bin/sh
# Botwx source installer.
#
#   curl -fsSL https://raw.githubusercontent.com/0x8u/botwx/main/install.sh | sh
#
# Downloads a snapshot from GitHub, installs locked dependencies, builds Botwx,
# and replaces ~/.botwx/app with rollback on failure. WeChat credentials and
# conversation state elsewhere under ~/.botwx are never replaced.
#
# Overrides:
#   BOTWX_REPO         GitHub owner/repository (default: 0x8u/botwx)
#   BOTWX_REF          branch, tag, or commit to install (default: main)
#   BOTWX_HOME         installation root (default: ~/.botwx)
#   BOTWX_INSTALL_DIR  executable directory (default: $BOTWX_HOME/bin)
#   BOTWX_ARCHIVE_URL  archive override for mirrors/testing
set -eu

REPO="${BOTWX_REPO:-0x8u/botwx}"
REF="${BOTWX_REF:-main}"
BOTWX_ROOT="${BOTWX_HOME:-$HOME/.botwx}"
APP_DIR="$BOTWX_ROOT/app"
BIN_DIR="${BOTWX_INSTALL_DIR:-$BOTWX_ROOT/bin}"
MARKER='# added by botwx installer'

err() {
  printf '%s\n' "botwx install: $*" >&2
  exit 1
}

case "$REPO" in
  */*) ;;
  *) err "BOTWX_REPO must look like owner/repository" ;;
esac
case "$REPO" in
  *[!A-Za-z0-9_.\/-]*) err "BOTWX_REPO contains unsupported characters" ;;
esac
case "$REF" in
  ''|/*|*..*|*[!A-Za-z0-9_.\/-]*) err "BOTWX_REF contains unsupported characters" ;;
esac
case "$BOTWX_ROOT" in
  ''|/) err "refusing unsafe BOTWX_HOME '$BOTWX_ROOT'" ;;
esac

command -v curl >/dev/null 2>&1 || err "curl is required"
command -v tar >/dev/null 2>&1 || err "tar is required"
command -v node >/dev/null 2>&1 || err "Node.js 22+ is required: https://nodejs.org/"
command -v bun >/dev/null 2>&1 || err "Bun 1.4.2 is required: https://bun.sh/"

node_major="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || printf 0)"
case "$node_major" in
  ''|*[!0-9]*) err "could not determine Node.js version" ;;
esac
[ "$node_major" -ge 22 ] || err "Node.js 22+ is required (found $(node --version 2>/dev/null || printf unknown))"

bun_version="$(bun --version 2>/dev/null || true)"
if [ "$bun_version" != "1.4.2" ]; then
  printf '%s\n' "⚠️  project is pinned to Bun 1.4.2; found ${bun_version:-unknown}. Continuing with the installed Bun."
fi

mkdir -p "$BOTWX_ROOT" "$BIN_DIR"
chmod 700 "$BOTWX_ROOT" 2>/dev/null || true

work="$(mktemp -d "${TMPDIR:-/tmp}/botwx-install.XXXXXX")"
stage="$(mktemp -d "$BOTWX_ROOT/.app-stage.XXXXXX")"
cleanup() {
  rm -rf "$work"
  if [ -n "$stage" ]; then
    rm -rf "$stage"
  fi
}
trap cleanup EXIT HUP INT TERM

archive="$work/botwx.tar.gz"
url="${BOTWX_ARCHIVE_URL:-https://github.com/$REPO/archive/$REF.tar.gz}"
printf '%s\n' "↓ downloading $REPO@$REF ..."
curl -fL --retry 3 --connect-timeout 15 "$url" -o "$archive" || err "download failed: $url"
tar -xzf "$archive" -C "$stage" --strip-components=1 || err "could not extract GitHub archive"
[ -f "$stage/package.json" ] || err "archive does not contain package.json"
[ -f "$stage/bun.lock" ] || err "archive does not contain bun.lock"

printf '%s\n' "↓ installing locked dependencies ..."
(
  cd "$stage"
  # Electron is only a legacy desktop development dependency and is not needed
  # by Botwx. Keep its large runtime out of a server/CLI installation while
  # still allowing node-pty's native install step to run.
  ELECTRON_SKIP_BINARY_DOWNLOAD=1 bun install --frozen-lockfile
) || err "dependency installation failed"

printf '%s\n' "↓ building botwx ..."
(cd "$stage" && bun run build) || err "build failed"
[ -x "$stage/dist/index-botwx.js" ] || err "build did not produce executable dist/index-botwx.js"

previous="$BOTWX_ROOT/app.previous"
if [ -e "$previous" ]; then
  rm -rf "$previous"
fi
if [ -e "$APP_DIR" ]; then
  mv "$APP_DIR" "$previous"
fi
if ! mv "$stage" "$APP_DIR"; then
  if [ -e "$previous" ] && [ ! -e "$APP_DIR" ]; then
    mv "$previous" "$APP_DIR" || true
  fi
  err "could not activate the staged installation; previous installation restored"
fi
stage=''

ln -sfn "$APP_DIR/dist/index-botwx.js" "$BIN_DIR/botwx"
printf '%s\n' "✅ installed botwx → $APP_DIR"
printf '%s\n' "✅ executable → $BIN_DIR/botwx"

# Add the binary directory to future shells. A child installer cannot modify the
# current parent shell, so the absolute command is also printed below.
single_quote() {
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
}
quoted_bin="'$(single_quote "$BIN_DIR")'"
posix_line="case \":\$PATH:\" in *:$quoted_bin:*) ;; *) export PATH=$quoted_bin\":\$PATH\" ;; esac  $MARKER"

append_once() {
  file="$1"
  line="$2"
  mkdir -p "$(dirname "$file")"
  if [ -f "$file" ] && grep -F "$MARKER" "$file" 2>/dev/null | grep -Fq "$quoted_bin"; then
    return 0
  fi
  if [ -f "$file" ] && [ -n "$(tail -c 1 "$file" 2>/dev/null)" ]; then
    printf '\n%s\n' "$line" >> "$file"
  else
    printf '%s\n' "$line" >> "$file"
  fi
  printf '%s\n' "✓ added $BIN_DIR to PATH in $file"
}

case "$(basename "${SHELL:-sh}")" in
  zsh) append_once "${ZDOTDIR:-$HOME}/.zshenv" "$posix_line" ;;
  bash) append_once "$HOME/.bashrc" "$posix_line" ;;
  fish)
    fish_file="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/botwx.fish"
    fish_line="contains $quoted_bin \$PATH; or set -gx PATH $quoted_bin \$PATH  $MARKER"
    append_once "$fish_file" "$fish_line"
    ;;
  *) append_once "$HOME/.profile" "$posix_line" ;;
esac

printf '\n%s\n' "Next (works immediately):"
printf '  %s\n' "$BIN_DIR/botwx setup"
printf '  %s\n' "$BIN_DIR/botwx start"
printf '%s\n' "Open a new terminal to use the shorter \`botwx\` command."
