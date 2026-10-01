#!/usr/bin/env bash
# TopCam — gera o APK de teste do app (Android) para uma marca (white label).
#
#   scripts/mobile-build-apk.sh [--brand topcam] [--api-url URL] [--all-abis]
#
# Pré-requisitos na máquina de build: Node 22, Java 17+ e o Android SDK em $ANDROID_HOME
# (platforms;android-36, build-tools;36.0.0, ndk;27.1.12297006, cmake;3.22.1).
#
#   --brand     pasta em apps/mobile/brands/ (brand.json + logo.png opcional)
#   --api-url   outro servidor (ex.: http://172.31.141.30 no laboratório); padrão: o da marca
#   --all-abis  também celulares 32 bits (armeabi-v7a). Padrão: só arm64-v8a (mais rápido)
#
# Saída: reports/apk/<marca>-<versão>.apk. É um APK de TESTE (assinado com a chave de
# depuração): instala direto no celular, mas não vai para a Play Store (isso é a 9.4).
set -euo pipefail
cd "$(dirname "$0")/../apps/mobile"

BRAND=topcam API_URL="" ABIS=arm64-v8a
while [ $# -gt 0 ]; do
  case "$1" in
    --brand) BRAND="$2"; shift 2 ;;
    --api-url) API_URL="$2"; shift 2 ;;
    --all-abis) ABIS=armeabi-v7a,arm64-v8a; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "opção desconhecida: $1" >&2; exit 2 ;;
  esac
done
[ -f "brands/$BRAND/brand.json" ] || { echo "marca não encontrada: brands/$BRAND/brand.json" >&2; exit 2; }
: "${ANDROID_HOME:?defina ANDROID_HOME (Android SDK)}"

export BRAND
[ -n "$API_URL" ] && export API_URL
[ -d "brands/$BRAND/generated" ] || python3 scripts/brand-assets.py "$BRAND"
npm ci --no-audit --no-fund
# O projeto nativo é gerado a cada build a partir da configuração da marca (não é versionado).
npx expo prebuild --platform android --clean --no-install
echo "sdk.dir=$ANDROID_HOME" > android/local.properties
sed -i 's/^org.gradle.jvmargs=.*/org.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=1024m/' android/gradle.properties
(cd android && ./gradlew assembleRelease -PreactNativeArchitectures="$ABIS")

VERSION=$(node -p "require('./package.json').version")
mkdir -p ../../reports/apk
OUT="../../reports/apk/${BRAND}-${VERSION}.apk"
cp android/app/build/outputs/apk/release/app-release.apk "$OUT"
echo "APK: reports/apk/$(basename "$OUT") ($(du -h "$OUT" | cut -f1); ABIs: $ABIS; servidor: ${API_URL:-o da marca})"
