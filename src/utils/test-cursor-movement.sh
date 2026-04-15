#!/bin/bash
# Test cursor movement and edge cases

SESSION="mycc-test"

start_session() {
    tmux kill-session -t $SESSION 2>/dev/null
    tmux new-session -d -s $SESSION 'pnpm start --skip-healthcheck 2>&1'
    sleep 2
    tmux resize-window -t $SESSION -x 40 -y 24
}

send_keys() {
    tmux send-keys -t $SESSION "$1"
    sleep 0.05
}

send_key() {
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

    echo "=== Test: Cursor Movement and Edge Cases ==="
    echo "============================================"

    capture "Initial state"

    # Test 1: Home and End keys
    echo "Test 1: Home/End keys"
    send_keys "hello world"
    capture "After typing 'hello world'"
    
    send_key Home
    capture "After Home (cursor at start)"
    
    send_keys "XX"
    capture "After typing 'XX' at start"
    
    send_key End
    capture "After End (cursor at end)"
    
    send_keys "YY"
    capture "After typing 'YY' at end"

    # Test 2: Delete key
    echo "Test 2: Delete key"
    send_key Home
    send_key Right
    capture "After moving right one char"
    
    for i in {1..3}; do
        tmux send-keys -t $SESSION Delete
        sleep 0.05
    done
    capture "After 3 Delete presses"

    # Test 3: Ctrl+A and Ctrl+E
    echo "Test 3: Ctrl+A / Ctrl+E"
    tmux send-keys -t $SESSION C-a
    sleep 0.1
    capture "After Ctrl+A (home)"
    
    send_keys "START"
    capture "After typing 'START'"
    
    tmux send-keys -t $SESSION C-e
    sleep 0.1
    capture "After Ctrl+E (end)"
    
    send_keys "END"
    capture "After typing 'END'"

    # Test 4: Ctrl+K (delete to end)
    echo "Test 4: Ctrl+K"
    send_key Home
    for i in {1..5}; do
        tmux send-keys -t $SESSION Right
        sleep 0.05
    done
    capture "After moving to position 5"
    
    tmux send-keys -t $SESSION C-k
    sleep 0.1
    capture "After Ctrl+K (delete to end)"

    # Test 5: Ctrl+U (delete to start)
    echo "Test 5: Ctrl+U"
    send_key End
    for i in {1..3}; do
        tmux send-keys -t $SESSION Left
        sleep 0.05
    done
    capture "After moving left 3 positions"
    
    tmux send-keys -t $SESSION C-u
    sleep 0.1
    capture "After Ctrl+U (delete to start)"

    # Test 6: Empty line operations
    echo "Test 6: Empty line operations"
    for i in {1..20}; do
        tmux send-keys -t $SESSION BSpace
        sleep 0.02
    done
    capture "After clearing all text"
    
    send_key Left
    capture "Left on empty line (should do nothing)"
    
    send_key Right
    capture "Right on empty line (should do nothing)"
    
    send_key BSpace
    capture "Backspace on empty line (should do nothing)"

    tmux kill-session -t $SESSION 2>/dev/null
    echo "=== Test complete ==="
}

main "$@"