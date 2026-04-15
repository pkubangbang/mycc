#!/bin/bash
# Test backspace in middle of line 1

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

    echo "=== Test: Backspace in middle of line 1 ==="
    echo "Window: 40 chars, Prompt: 9 chars"
    echo "============================================"

    capture "Initial state"

    # Add 40 chars to make two lines
    # Line 0 (prompt line): 31 chars (40 - 9 = 31)
    # Line 1: 9 chars
    echo "Adding 40 chars..."
    send_keys "1234567890123456789012345678901234567890"
    capture "After adding 40 chars (should be 2 lines)"

    # Move cursor back to middle of line 1
    # Line 0 has 31 chars, so we need to move left from end to get to middle
    # Middle of line 0 would be around position 15
    # From end, that's 40 - 15 = 25 positions to move left
    # But we're at end of line 1, so we need to go left across line boundary
    echo "Moving cursor back to middle of line 0..."

    # Move left 25 times to get to position 15 on line 0
    for i in {1..25}; do
        tmux send-keys -t $SESSION Left
        sleep 0.02
    done
    capture "After moving cursor back (should be in middle of line 0)"

    # Now hit backspace
    echo "Pressing backspace..."
    send_keys BSpace
    capture "After backspace in middle of line 0"

    # Hit backspace again
    echo "Pressing backspace again..."
    send_keys BSpace
    capture "After second backspace"

    # Add some chars to verify state
    echo "Adding chars to verify..."
    send_keys "XX"
    capture "After adding 'XX'"

    tmux kill-session -t $SESSION 2>/dev/null
}

main "$@"