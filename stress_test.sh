#!/bin/bash
# Creates misbehaving processes so you can watch the manager react.
# Run the manager in another terminal first:  ./smart_rm
cd "$(dirname "$0")"
trap 'kill -9 $YES_PID $LEAK_PID $STUB_PID 2>/dev/null; echo; echo "cleaned up"; exit' INT TERM EXIT

echo "[1/3] CPU hog (yes)        -> expect RENICE then KILL"
yes > /dev/null &
YES_PID=$!
sleep 14

echo "[2/3] memory leak (./leak) -> expect PAUSE"
./leak &
LEAK_PID=$!
sleep 14

echo "[3/3] stubborn (ignores SIGTERM) -> expect RENICE, KILL, then KILL-9"
./stubborn &
STUB_PID=$!
sleep 20
