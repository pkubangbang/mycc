#!/bin/bash
# Test harness for LineEditor - captures detailed behavior

SESSION="mycc-test"

# Function to start session
start_session() {
    tmux kill-session -t $SESSION 2>/dev/null
    tmux new-session -d -s $SESSION 'pnpm start --skip-healthcheck 2>&1'
    sleep 2  # Wait for startup
    # Resize window to 40 chars width for consistent testing
    tmux resize-window -t $SESSION -x 40 -y 24
}

# Function to send input and capture
test_input() {
    local input="$1"
    local description="$2"

    echo "=== $description ==="
    echo "Input: '$input'"
    tmux send-keys -t $SESSION "$input"
    sleep 0.1
    tmux capture-pane -t $SESSION -p
    echo ""
}

# Function to send special key and capture
test_key() {
    local key="$1"
    local description="$2"

    echo "=== $description ==="
    case "$key" in
        BSpace) tmux send-keys -t $SESSION BSpace ;;
        Left) tmux send-keys -t $SESSION Left ;;
        Right) tmux send-keys -t $SESSION Right ;;
        Up) tmux send-keys -t $SESSION Up ;;
        Down) tmux send-keys -t $SESSION Down ;;
        Enter) tmux send-keys -t $SESSION Enter ;;
    esac
    sleep 0.1
    tmux capture-pane -t $SESSION -p
    echo ""
}

# Function to test rapid typing (simulates fast input)
test_rapid_input() {
    local chars="$1"
    local description="$2"

    echo "=== $description ==="
    echo "Input: rapid '$chars'"
    for ((i=0; i<${#chars}; i++)); do
        tmux send-keys -t $SESSION "${chars:$i:1}"
        sleep 0.01
    done
    sleep 0.1
    tmux capture-pane -t $SESSION -p
    echo ""
}

# Function to test rapid backspace
test_rapid_backspace() {
    local count="$1"
    local description="$2"

    echo "=== $description ==="
    echo "Action: $count backspaces"
    for ((i=0; i<count; i++)); do
        tmux send-keys -t $SESSION BSpace
        sleep 0.01
    done
    sleep 0.1
    tmux capture-pane -t $SESSION -p
    echo ""
}

# Main test flow
main() {
    echo "============================================"
    echo "LineEditor Test Harness"
    echo "Window: 40 chars wide"
    echo "============================================"
    start_session

    echo "=== Initial state ==="
    tmux capture-pane -t $SESSION -p
    echo ""

    # Test suite 1: Basic typing
    echo "=== SUITE 1: BASIC TYPING ==="
    test_input "hello" "Type 'hello'"
    test_input " world" "Type ' world'"
    test_input "12345678901234567890123456789" "Fill first line (29 chars)"

    # Test suite 2: Wrap boundary
    echo "=== SUITE 2: WRAP BOUNDARY ==="
    test_input "0" "Add 30th char (wraps to line 2)"
    test_input "A" "Add char on line 2"
    test_input "BCDEFGHIJ" "Add more on line 2"

    # Test suite 3: Backspace behavior
    echo "=== SUITE 3: BACKSPACE ==="
    test_key BSpace "Backspace at end"
    test_key BSpace "Backspace again"
    test_rapid_backspace 10 "Rapid backspace (10 chars)"

    # Test suite 4: Cursor movement
    echo "=== SUITE 4: CURSOR MOVEMENT ==="
    test_key Left "Arrow left"
    test_key Left "Arrow left again"
    test_key Right "Arrow right"
    test_input "X" "Insert 'X' in middle"

    # Test suite 5: Rapid input (flicker test)
    echo "=== SUITE 5: RAPID INPUT (flicker test) ==="
    test_rapid_input "12345678901234567890123456789012345678901234567890" "Rapid 50 chars"
    test_rapid_backspace 25 "Rapid backspace 25 chars"

    # Test suite 6: Clear and restart
    echo "=== SUITE 6: CLEAR AND RESTART ==="
    tmux send-keys -t $SESSION Enter
    sleep 0.5
    tmux capture-pane -t $SESSION -p
    echo ""

    test_input "test" "Type after Enter"
    test_key BSpace "Backspace after restart"
    test_key BSpace "Backspace again"

    # Cleanup
    tmux kill-session -t $SESSION 2>/dev/null
    echo "=== Test complete ==="
}

main "$@"