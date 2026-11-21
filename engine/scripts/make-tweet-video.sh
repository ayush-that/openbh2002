#!/usr/bin/env bash
# Convert a recorder take (artifacts/video/*.mp4|webm) into an X-ready MP4:
# H.264 High, yuv420p, 1920x1080, constant 60 fps (30 if the source averages under 50), +faststart,
# AAC-LC 48 kHz 192 kbps stereo, two-pass EBU R128 loudness normalisation to -14 LUFS (true peak -1.5 dBTP).
# Usage: scripts/make-tweet-video.sh <input> [output.mp4] [--in <seconds>] [--out <seconds>]
set -euo pipefail

FFMPEG=${FFMPEG:-/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg}
FFPROBE=${FFPROBE:-$(dirname "$FFMPEG")/ffprobe}
[ -x "$FFMPEG" ] || FFMPEG=ffmpeg
[ -x "$FFPROBE" ] || FFPROBE=ffprobe

IN="" OUT="" SS="" TO=""
while [ $# -gt 0 ]; do
  case "$1" in
    --in) SS=$2; shift 2 ;;
    --out) TO=$2; shift 2 ;;
    -h|--help) sed -n '2,5p' "$0"; exit 0 ;;
    *) if [ -z "$IN" ]; then IN=$1; elif [ -z "$OUT" ]; then OUT=$1; else echo "unexpected argument: $1" >&2; exit 2; fi; shift ;;
  esac
done
[ -n "$IN" ] && [ -f "$IN" ] || { echo "usage: $0 <input> [output.mp4] [--in s] [--out s]" >&2; exit 2; }
[ -n "$OUT" ] || OUT="${IN%.*}-x.mp4"

TRIM=()
[ -n "$SS" ] && TRIM+=(-ss "$SS")
[ -n "$TO" ] && TRIM+=(-to "$TO")

# MediaRecorder output is variable frame rate: average fps = video packets / duration.
read -r PACKETS DUR < <("$FFPROBE" -v error -select_streams v:0 -count_packets \
  -show_entries stream=nb_read_packets:format=duration -of default=nw=1:nk=1 "$IN" | tr '\n' ' ') || true
FPS=60
if awk -v p="$PACKETS" -v d="$DUR" 'BEGIN { exit !(d > 0 && p / d < 50) }'; then FPS=30; fi
HAS_AUDIO=$("$FFPROBE" -v error -select_streams a -show_entries stream=index -of csv=p=0 "$IN" | head -1)
echo "source: $PACKETS frames / ${DUR}s -> ${FPS} fps, audio: ${HAS_AUDIO:+yes}${HAS_AUDIO:-no}"

VF="scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=$FPS,format=yuv420p"
VIDEO=(-c:v libx264 -preset slow -crf 16 -profile:v high -level 4.2 -pix_fmt yuv420p -r "$FPS" -fps_mode cfr
  -g $((FPS * 2)) -maxrate 25M -bufsize 50M -color_primaries bt709 -color_trc bt709 -colorspace bt709)

if [ -n "$HAS_AUDIO" ]; then
  # Pass 1: measure loudness of the trimmed audio.
  STATS=$("$FFMPEG" -hide_banner -nostats "${TRIM[@]}" -i "$IN" -vn \
    -af loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json -f null - 2>&1 | sed -n '/^{/,/^}/p')
  val() { printf '%s' "$STATS" | sed -n "s/.*\"$1\" : \"\\([^\"]*\\)\".*/\\1/p"; }
  MI=$(val input_i) MTP=$(val input_tp) MLRA=$(val input_lra) MTH=$(val input_thresh) OFF=$(val target_offset)
  echo "measured: ${MI} LUFS, ${MTP} dBTP, LRA ${MLRA}"
  if [ "$MI" = "-inf" ] || [ -z "$MI" ]; then
    AF="aresample=48000"
    echo "warning: audio is silent, skipping loudness normalisation" >&2
  else
    AF="loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=$MI:measured_TP=$MTP:measured_LRA=$MLRA:measured_thresh=$MTH:offset=$OFF:linear=true,aresample=48000"
  fi
  "$FFMPEG" -hide_banner -y "${TRIM[@]}" -i "$IN" -map 0:v:0 -map 0:a:0 -vf "$VF" "${VIDEO[@]}" \
    -af "$AF" -c:a aac -b:a 192k -ar 48000 -ac 2 -movflags +faststart "$OUT"
else
  "$FFMPEG" -hide_banner -y "${TRIM[@]}" -i "$IN" -map 0:v:0 -vf "$VF" "${VIDEO[@]}" -an -movflags +faststart "$OUT"
fi

SIZE=$(stat -f %z "$OUT" 2>/dev/null || stat -c %s "$OUT")
LEN=$("$FFPROBE" -v error -show_entries format=duration -of default=nw=1:nk=1 "$OUT")
echo "wrote $OUT ($((SIZE / 1048576)) MB, ${LEN}s)"
awk -v l="$LEN" 'BEGIN { if (l > 140) print "warning: longer than X limit of 2:20" }'
[ "$SIZE" -le $((512 * 1048576)) ] || echo "warning: over X limit of 512 MB" >&2
