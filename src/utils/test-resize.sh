#!/bin/bash
# Test window resize behavior

SESSION="mycc-test"

start_session() {
    tmux kill-session -t $SESSION 2>/dev/null
    tmux new-session -d -s $SESSION 'pnpm start --skip-healthcheck 2>&1'
    sleep 2
    tmux resize-window -t $SESSION -x 40 -y 24
}

send_keys() {
    tmux send-keys -t $SESSION "$1"
    sleep 0.1
}

capture() {
    echo "=== $1 ==="
    tmux capture-pane -t $SESSION -p
    echo ""
}

main() {
    start_session

    echo "=== Test: Window Resize Behavior ==="
    echo "====================================="

    capture "Initial state (40 cols)"

    # Type some text
    send_keys "1234567890123456789012345678901234567890"
    capture "After typing 40 chars (should be 2 lines)"

    # Resize to wider
    tmux resize-window -t $SESSION -x 60 -y 24
    sleep 0.3
    capture "After resize to 60 cols (should be 1 line)"

    # Resize back to 40
    tmux resize-window -t $SESSION -x 40 -y 24
    sleep 0.3
    capture "After resize back to 40 cols (should be 2 lines)"

    # Resize to narrow
    tmux resize-window -t $SESSION -x 30 -y 24
    sleep 0.3
    capture "After resize to 30 cols (should be more lines)"

    # Type more at narrow width
    send_keys "ABCDE"
    capture "After typing at narrow width"

    # Resize back to 40
    tmux resize-window -t $SESSION -x 40 -y 24
    sleep 0.3
    capture "After resize back to 40 cols"

    tmux kill-session -t $SESSION 2>/dev/null
    echo "=== Test complete ==="
}

main "$@"