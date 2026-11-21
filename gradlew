#!/bin/sh
set -eu
APP_HOME=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
GRADLE_VERSION="9.3.1"
GRADLE_USER_HOME="${GRADLE_USER_HOME:-$HOME/.gradle}"
DIST_DIR="$GRADLE_USER_HOME/wrapper/dists/gradle-$GRADLE_VERSION"
GRADLE_BIN="$DIST_DIR/gradle-$GRADLE_VERSION/bin/gradle"

if command -v gradle >/dev/null 2>&1; then exec gradle "$@"; fi
if [ -x "$GRADLE_BIN" ]; then exec "$GRADLE_BIN" "$@"; fi

TMP_ZIP="$GRADLE_USER_HOME/gradle-$GRADLE_VERSION-bin.zip"
mkdir -p "$DIST_DIR"
echo "Gradle $GRADLE_VERSION not found; downloading it..."
if command -v curl >/dev/null 2>&1; then
  curl -fL --retry 3 -o "$TMP_ZIP" "https://services.gradle.org/distributions/gradle-$GRADLE_VERSION-bin.zip"
elif command -v wget >/dev/null 2>&1; then
  wget -O "$TMP_ZIP" "https://services.gradle.org/distributions/gradle-$GRADLE_VERSION-bin.zip"
else
  echo "ERROR: curl or wget is required to bootstrap Gradle." >&2; exit 1
fi
command -v unzip >/dev/null 2>&1 || { echo "ERROR: unzip is required." >&2; exit 1; }
rm -rf "$DIST_DIR"
mkdir -p "$GRADLE_USER_HOME/wrapper/dists"
unzip -q "$TMP_ZIP" -d "$GRADLE_USER_HOME/wrapper/dists"
exec "$GRADLE_BIN" "$@"
