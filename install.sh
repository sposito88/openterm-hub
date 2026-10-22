#!/bin/sh
# OpenTerm Hub installer for Linux and macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/sposito88/openterm-hub/main/install.sh | sh
#
# Options (environment variables):
#   OPENTERM_VERSION=v0.3.7   install a specific release instead of the latest
#   OPENTERM_APPIMAGE=1       Linux: install the AppImage (no sudo) even where .deb works
#   OPENTERM_DRY_RUN=1        download and verify only, install nothing
#
# Every download is checked against the release's SHA256SUMS.txt before use.
set -eu

REPO="sposito88/openterm-hub"
API="https://api.github.com/repos/$REPO/releases"

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merro:\033[0m %s\n' "$*" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

fetch() { # fetch URL FILE
  if has curl; then curl -fsSL --retry 3 -o "$2" "$1"
  elif has wget; then wget -q -O "$2" "$1"
  else die "é preciso curl ou wget"; fi
}

sha256() {
  if has sha256sum; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

run_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"
  elif has sudo; then sudo "$@"
  else die "é preciso ser root ou ter sudo para: $*"; fi
}

TMP=$(mktemp -d 2>/dev/null || mktemp -d -t openterm)
trap 'rm -rf "$TMP"' EXIT INT TERM

# --- which release -----------------------------------------------------------
if [ -n "${OPENTERM_VERSION:-}" ]; then
  RELEASE_URL="$API/tags/$OPENTERM_VERSION"
else
  RELEASE_URL="$API/latest"
fi
fetch "$RELEASE_URL" "$TMP/release.json" || die "não consegui consultar o release ($RELEASE_URL)"
TAG=$(sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' "$TMP/release.json" | head -n 1)
[ -n "$TAG" ] || die "release não encontrado"
VERSION=${TAG#v}

asset_url() { # first asset whose name matches the given grep pattern
  sed -n 's/.*"browser_download_url": *"\([^"]*\)".*/\1/p' "$TMP/release.json" | grep -E -e "$1" | head -n 1
}

# --- which file for this machine ---------------------------------------------
OS=$(uname -s)
ARCH=$(uname -m)
MODE=""
case "$OS" in
  Linux)
    case "$ARCH" in
      x86_64|amd64) DEB_ARCH=amd64; IMG_ARCH=x86_64 ;;
      aarch64|arm64) DEB_ARCH=arm64; IMG_ARCH=arm64 ;;
      *) die "Linux $ARCH ainda não tem build oficial (só x86_64 e arm64). Rode a partir do código: https://github.com/$REPO" ;;
    esac
    if [ -z "${OPENTERM_APPIMAGE:-}" ] && has apt-get && has dpkg; then
      MODE=deb; PATTERN="-linux-$DEB_ARCH\\.deb\$"
    else
      MODE=appimage; PATTERN="-linux-$IMG_ARCH\\.AppImage\$"
    fi
    ;;
  Darwin)
    MODE=mac
    case "$ARCH" in
      arm64) PATTERN='-mac-arm64\.zip$' ;;
      x86_64) PATTERN='-mac-x64\.zip$' ;;
      *) die "arquitetura não suportada: $ARCH" ;;
    esac
    ;;
  *) die "sistema não suportado: $OS. No Windows use: irm https://raw.githubusercontent.com/$REPO/main/install.ps1 | iex" ;;
esac

URL=$(asset_url "$PATTERN")
SUMS_URL=$(asset_url 'SHA256SUMS\.txt$')
[ -n "$URL" ] || die "o release $TAG não tem um pacote para $OS/$ARCH"
[ -n "$SUMS_URL" ] || die "o release $TAG não publica SHA256SUMS.txt; instale manualmente em https://github.com/$REPO/releases"
FILE=$(basename "$URL")

say "OpenTerm Hub $VERSION ($FILE)"
fetch "$URL" "$TMP/$FILE"
fetch "$SUMS_URL" "$TMP/SHA256SUMS.txt"

EXPECTED=$(grep -e " $FILE\$" "$TMP/SHA256SUMS.txt" | cut -d' ' -f1 | head -n 1)
[ -n "$EXPECTED" ] || die "$FILE não está no SHA256SUMS.txt"
ACTUAL=$(sha256 "$TMP/$FILE")
[ "$EXPECTED" = "$ACTUAL" ] || die "SHA-256 não confere para $FILE (esperado $EXPECTED, obtido $ACTUAL)"
say "SHA-256 verificado"

if [ -n "${OPENTERM_DRY_RUN:-}" ]; then
  say "OPENTERM_DRY_RUN: nada foi instalado ($MODE)"
  exit 0
fi

# --- install -----------------------------------------------------------------
case "$MODE" in
  deb)
    chmod 755 "$TMP"
    chmod 644 "$TMP/$FILE"
    say "Instalando o pacote .deb (pode pedir a sua senha do sudo)"
    run_root apt-get install -y "$TMP/$FILE"
    say "Pronto! Abra o OpenTerm Hub pelo menu de aplicativos ou rode: openterm-hub"
    ;;
  appimage)
    BIN="${XDG_BIN_HOME:-$HOME/.local/bin}"
    APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
    ICONS="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/512x512/apps"
    mkdir -p "$BIN" "$APPS" "$ICONS"
    install -m 0755 "$TMP/$FILE" "$BIN/openterm-hub"
    fetch "https://raw.githubusercontent.com/$REPO/$TAG/resources/icons/512x512.png" "$ICONS/openterm-hub.png" || true
    cat > "$APPS/openterm-hub.desktop" <<EOF
[Desktop Entry]
Name=OpenTerm Hub
Comment=Open source desktop SSH client
Exec=$BIN/openterm-hub %U
Icon=openterm-hub
Type=Application
Categories=Network;
StartupWMClass=openterm-hub
EOF
    say "Instalado em $BIN/openterm-hub"
    case ":$PATH:" in *":$BIN:"*) ;; *) say "Dica: adicione $BIN ao seu PATH" ;; esac
    say "Se o AppImage não abrir, instale o FUSE 2 (ex.: libfuse2)."
    ;;
  mac)
    say "Instalando em /Applications"
    DEST=/Applications
    [ -w "$DEST" ] || DEST="$HOME/Applications"
    mkdir -p "$DEST"
    ditto -xk "$TMP/$FILE" "$TMP/app"
    APP=$(find "$TMP/app" -maxdepth 1 -name '*.app' | head -n 1)
    [ -n "$APP" ] || die "o .zip não contém um .app"
    rm -rf "$DEST/OpenTerm Hub.app"
    ditto "$APP" "$DEST/OpenTerm Hub.app"
    say "Pronto! Abra o OpenTerm Hub em $DEST (ou: open -a 'OpenTerm Hub')"
    ;;
esac
