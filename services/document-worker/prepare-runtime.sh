#!/usr/bin/env bash
set -euo pipefail
umask 077
export LC_ALL=C

language=
if (( $# )); then
  if [[ $# != 2 || "$1" != --ocr-language || ( "$2" != eng && "$2" != chi_sim ) ]]; then
    printf 'Usage: bash prepare-runtime.sh [--ocr-language eng|chi_sim]\n' >&2
    exit 2
  fi
  language=$2
fi

if [[ "$(id -u)" == 0 || "$(uname -m)" != x86_64 ]] || ! grep -qx 'VERSION_CODENAME=noble' /etc/os-release; then
  printf 'Run as an ordinary user on Ubuntu 24.04 x86-64.\n' >&2
  exit 2
fi

workspace=$(mktemp -d /tmp/assistant-document-runtime.XXXXXXXX)
runtime="$workspace/runtime"
archives="$workspace/archives"
packages="$workspace/packages"
mkdir -p "$archives" "$packages" "$runtime/usr/bin" "$runtime/lib64" \
  "$runtime/lib/x86_64-linux-gnu" "$runtime/etc/fonts" "$runtime/fonts"
dependencies=(poppler-utils libpoppler134 libopenjp2-7 libnss3 libnspr4)
executables=(pdfinfo pdftotext)
if [[ -n "$language" ]]; then
  dependencies+=(tesseract-ocr libtesseract5 liblept5 libarchive13t64 libgif7 libgomp1 libwebpmux3
    "tesseract-ocr-${language//_/-}")
  executables+=(pdfimages pdftoppm tesseract)
fi

(
  cd "$archives"
  apt-get download "${dependencies[@]}" >&2
  for archive in ./*.deb; do
    name=$(dpkg-deb -f "$archive" Package)
    version=$(dpkg-deb -f "$archive" Version)
    expected=$(apt-cache show "$name=$version" | sed -n 's/^SHA256: //p' | sort -u)
    actual=$(sha256sum "$archive" | cut -d' ' -f1)
    if [[ ! "$expected" =~ ^[0-9a-f]{64}$ || "$expected" != "$actual" ]]; then
      printf 'Downloaded package hash disagrees with the configured Ubuntu index.\n' >&2
      exit 3
    fi
    printf '%s %s %s\n' "$name" "$version" "$actual" >> "$workspace/signed-index-receipt.txt"
    dpkg-deb -x "$archive" "$packages"
  done
)

install -m 755 -T /lib64/ld-linux-x86-64.so.2 "$runtime/lib64/ld-linux-x86-64.so.2"
for extractor in "${executables[@]}"; do
  install -m 755 "$packages/usr/bin/$extractor" "$runtime/usr/bin/"
  env -i PATH=/usr/bin:/bin LC_ALL=C LD_LIBRARY_PATH="$packages/usr/lib/x86_64-linux-gnu" \
    /usr/bin/ldd "$runtime/usr/bin/$extractor" >> "$workspace/linkage.txt"
done
if grep -q '=> not found' "$workspace/linkage.txt"; then
  printf 'Ubuntu runtime dependencies are incomplete.\n' >&2
  exit 3
fi
while read -r name source; do
  if [[ ! "$name" =~ ^[A-Za-z0-9_+.-]+$ || "$source" != /* || ! -f "$source" ]]; then
    printf 'Could not resolve the approved runtime closure.\n' >&2
    exit 3
  fi
  install -m 644 -T "$source" "$runtime/lib/x86_64-linux-gnu/$name"
done < <(awk '/=> \// { print $1, $3 }' "$workspace/linkage.txt" | sort -u)

if [[ -n "$language" ]]; then
  model=$(find "$packages/usr/share/tesseract-ocr" -type f -name "$language.traineddata")
  if [[ ! -f "$model" ]]; then
    printf 'The selected Ubuntu OCR model is unavailable.\n' >&2
    exit 3
  fi
  mkdir "$runtime/tessdata"
  install -m 644 "$model" "$runtime/tessdata/"
fi

cat > "$runtime/etc/fonts/fonts.conf" <<'XML'
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <dir>/fonts</dir>
  <cachedir>/cache</cachedir>
</fontconfig>
XML
font=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf
if [[ -f "$font" ]]; then
  install -m 644 "$font" "$runtime/fonts/"
fi
printf 'document-worker-runtime-v1\n' > "$runtime/.document-worker-runtime-v1"
printf '%s\n' "$runtime"
