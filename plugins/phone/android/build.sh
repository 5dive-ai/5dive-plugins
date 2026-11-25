#!/usr/bin/env bash
# Builds ../lib/type.dex from src/ — the one file `5dive phone` copies to the
# phone (for a moment) to type text beyond plain English letters. Needs a JDK.
# The build is reproducible: the same JDK major and D8 give the same bytes, and
# tests/phone_unit.sh checks the committed file against lib/type.dex.sha256.
#   R8_JAR=<path to r8-8.5.35.jar>  (downloaded from Google's Maven if unset)
set -euo pipefail
cd "$(dirname "$0")"
R8_VERSION=8.5.35
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
jar="${R8_JAR:-$work/r8.jar}"
[[ -r "$jar" ]] || curl -sSfL -o "$jar" "https://dl.google.com/dl/android/maven2/com/android/tools/r8/$R8_VERSION/r8-$R8_VERSION.jar"
javac --release 8 -nowarn -d "$work/classes" $(find src -name '*.java')
java -cp "$jar" com.android.tools.r8.D8 --release --min-api 26 --output "$work" $(find "$work/classes" -name '*.class')
cp "$work/classes.dex" ../lib/type.dex
( cd ../lib && sha256sum type.dex > type.dex.sha256 )
cat ../lib/type.dex.sha256
