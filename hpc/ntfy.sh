#!/usr/bin/env bash

# --- Configuration ---
TOPIC="anvl"          # Replace with your actual ntfy topic name
SERVER="https://ntfy.sh"         # Change if using a self-hosted instance
INTERVAL=1800                     # 10 minutes in seconds

cleanup() {
    echo -e "\nStopped."
    exit 0
}
trap cleanup SIGINT

# Define the shell commands to run and report
generate_report() {
    echo "=== System Status: $(date '+%Y-%m-%d %H:%M:%S') ==="
    echo ""
    echo "--- # processes still running ---"
    squeue --me|wc
    echo ""
    echo "--- Disk usage ---"
    du -hs /nobackup/cqlx43/anvl-sweeps
}

echo "Sending command output to ${SERVER}/${TOPIC} every $((INTERVAL / 60)) minutes. Press Ctrl+C to stop."

while true; do
    TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

    # Stream the output directly into curl preserving multi-line layout
    generate_report | curl -s \
        -H "Title: Periodic System Report" \
        -H "Tags: bar_chart" \
        --data-binary @- \
        "${SERVER}/${TOPIC}" > /dev/null

    echo "[${TIMESTAMP}] Report sent."
    sleep "${INTERVAL}"
done

