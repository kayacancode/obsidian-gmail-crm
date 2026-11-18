#!/bin/sh
# Real macOS window capture for the proving-it-works stills route.
# Obtain the current visible Obsidian window ID and pass it explicitly.
# Store private captures outside this repository; never upload contact data.
set -eu
: "${1:?Usage: capture-obsidian-window.sh WINDOW_ID OUTPUT.png}"
: "${2:?Usage: capture-obsidian-window.sh WINDOW_ID OUTPUT.png}"
screencapture -x -l "$1" "$2"
