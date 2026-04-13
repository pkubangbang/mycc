#!/bin/bash
# Test script for process model (coordinator -> lead -> teammates)
# Tests both live version (pnpm start) and installed version (mycc)

# Don't use set -e - we want to continue even if individual tests fail

# Configuration
TESTS_DIR="$(dirname "$0")"
PROJECT_ROOT="$(dirname "$TESTS_DIR")"
DIST_DIR="$PROJECT_ROOT/dist"
LOG_DIR="$DIST_DIR/test-logs"
SESSION="mycc_test_$$"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Test counters
TESTS_PASSED=0
TESTS_FAILED=0

# Ensure log directory exists
mkdir -p "$LOG_DIR"

# Logging functions
log() {
    echo -e "${BLUE}[$(date '+%H:%M:%S')]${NC} $1"
}

pass() {
    echo -e "${GREEN}✓ PASS: $1${NC}"
    ((TESTS_PASSED++))
}

fail() {
    echo -e "${RED}✗ FAIL: $1${NC}"
    ((TESTS_FAILED++))
}

# Cleanup function
cleanup() {
    log "Cleaning up tmux session: $SESSION"
    tmux kill-session -t "$SESSION" 2>/dev/null || true
}
trap cleanup EXIT

# Helper: Wait for pattern in tmux output
wait_for_pattern() {
    local pattern="$1"
    local timeout="${2:-30}"
    local log_file="$3"
    log "Waiting for pattern: '$pattern' (timeout: ${timeout}s)"

    for i in $(seq 1 "$timeout"); do
        local output
        output=$(tmux capture-pane -t "$SESSION" -p | tail -100)

        if [ -n "$log_file" ]; then
            echo "$output" >> "$log_file"
        fi

        if echo "$output" | grep -q "$pattern"; then
            log "Found pattern: '$pattern' after ${i}s"
            return 0
        fi
        sleep 1
    done

    log "Timeout waiting for: '$pattern'"
    return 1
}

# Helper: Send keys to tmux
send_keys() {
    tmux send-keys -t "$SESSION" "$1" Enter
}

# Helper: Get tmux output
get_output() {
    tmux capture-pane -t "$SESSION" -p | tail -100
}

# Helper: Start app (live or installed)
start_app() {
    local version="$1"  # "live" or "installed"
    local cwd="$2"

    log "Starting app ($version) in $cwd"

    tmux new-session -d -s "$SESSION" -x 200 -y 50 -c "$cwd"

    if [ "$version" = "live" ]; then
        send_keys "cd $PROJECT_ROOT && npx tsx src/index.ts --skip-healthcheck"
    else
        send_keys "cd $cwd && mycc --skip-healthcheck"
    fi
}

# Helper: Stop app
stop_app() {
    log "Stopping app (killing tmux session)"
    tmux kill-session -t "$SESSION" 2>/dev/null || true
    sleep 1
}

# =============================================================================
# Test 1: Simple startup and exit
# =============================================================================
test_simple_exit() {
    local version="$1"
    local test_name="Test 1 ($version): Simple startup and exit"
    local log_file="$LOG_DIR/test1_${version}.log"

    log "$test_name"
    echo "=== $test_name ===" > "$log_file"

    # Start app
    start_app "$version" "/tmp"
    wait_for_pattern "agent >>" 45 "$log_file" || {
        fail "$test_name - App did not start"
        stop_app
        return 1
    }

    # Send "exit" command
    log "Sending 'exit' command"
    send_keys "exit"

    # Wait for exit
    sleep 3
    get_output >> "$log_file"

    # Check if we're back to shell prompt (no agent prompt in last few lines)
    local output
    output=$(get_output | tail -10)

    if echo "$output" | grep -qE "^\s*agent >>"; then
        # Still showing agent prompt on a new line
        fail "$test_name - App still running"
        log "Last output lines:"
        echo "$output" | head -5
    elif echo "$output" | grep -qE "(Shutting down|ELIFECYCLE|\$\s*$)"; then
        pass "$test_name - App exited cleanly"
    else
        # Check if we see shell prompt (app exited)
        if echo "$output" | grep -qE "@.*\$\s*$"; then
            pass "$test_name - App exited (shell prompt visible)"
        else
            pass "$test_name - App likely exited (no agent prompt)"
        fi
    fi

    stop_app
}

# =============================================================================
# Test 2: Working directory correctness
# =============================================================================
test_cwd() {
    local version="$1"
    local test_name="Test 2 ($version): Working directory"
    local log_file="$LOG_DIR/test2_${version}.log"

    log "$test_name"
    echo "=== $test_name ===" > "$log_file"

    # Start app in /tmp
    start_app "$version" "/tmp"
    wait_for_pattern "agent >>" 45 "$log_file" || {
        fail "$test_name - App did not start"
        stop_app
        return 1
    }

    # Ask about current directory
    log "Asking: what is the current working dir?"
    send_keys "what is the current working directory?"
    wait_for_pattern "/tmp" 30 "$log_file" || {
        fail "$test_name - Did not see /tmp in response"
        stop_app
        return 1
    }

    get_output >> "$log_file"
    pass "$test_name - Correct working directory /tmp"

    # Exit cleanly
    send_keys "exit"
    sleep 2
    stop_app
}

# =============================================================================
# Test 3: Restart (directory change)
# =============================================================================
test_restart() {
    local version="$1"
    local test_name="Test 3 ($version): Restart on directory change"
    local log_file="$LOG_DIR/test3_${version}.log"

    log "$test_name"
    echo "=== $test_name ===" > "$log_file"

    # First, we need a session from a different directory
    # Find an existing session from ~/proj/mycc
    log "Looking for existing session from ~/proj/mycc"

    # Start app to list sessions
    start_app "$version" "/tmp"
    wait_for_pattern "agent >>" 45 "$log_file" || {
        fail "$test_name - App did not start"
        stop_app
        return 1
    }

    send_keys "/load"
    sleep 3
    get_output >> "$log_file"

    # Look for session with workdir containing "mycc"
    local output session_id
    output=$(get_output)

    # Extract session ID from line like: "  [abc123] 2026-..."
    session_id=$(echo "$output" | grep -oP '\[\K[a-f0-9]+' | head -1)

    if [ -z "$session_id" ]; then
        log "No sessions found, skipping restart test"
        echo "No sessions found - skipping" >> "$log_file"
        pass "$test_name - Skipped (no sessions found)"
        send_keys "exit"
        sleep 2
        stop_app
        return 0
    fi

    log "Found session: $session_id"

    # Find a session from ~/proj/mycc (different from /tmp)
    local mycc_session
    mycc_session=$(echo "$output" | grep "workdir:.*mycc" | grep -oP '\[\K[a-f0-9]+' | head -1)

    if [ -z "$mycc_session" ]; then
        log "No mycc session found, will create one"
        # Exit and create a session from mycc directory
        send_keys "exit"
        sleep 2
        stop_app

        # Start from mycc directory to create a session
        start_app "$version" "$PROJECT_ROOT"
        wait_for_pattern "agent >>" 45 "$log_file" || {
            fail "$test_name - App did not start from mycc dir"
            stop_app
            return 1
        }

        # Create a session by saying something
        send_keys "hello"
        wait_for_pattern "Session:" 20 "$log_file" || sleep 5
        get_output >> "$log_file"

        # Get the session ID
        mycc_session=$(get_output | grep -oP 'Session:\s*\K[a-f0-9-]+' | head -1)

        log "Created session: $mycc_session"

        # Exit and restart from /tmp
        send_keys "exit"
        sleep 2
        stop_app

        # Now start from /tmp and load the mycc session
        start_app "$version" "/tmp"
        wait_for_pattern "agent >>" 45 "$log_file" || {
            fail "$test_name - App did not start from /tmp"
            stop_app
            return 1
        }
    else
        log "Using existing mycc session: $mycc_session"
    fi

    # Load the mycc session (this should trigger restart)
    log "Loading session $mycc_session (should trigger restart)"
    send_keys "/load $mycc_session"

    # Wait for restart message
    if wait_for_pattern "Spawning new agent" 20 "$log_file"; then
        log "Restart triggered"
    else
        # Check if session directory matched (no restart needed)
        local new_output
        new_output=$(get_output)
        if echo "$new_output" | grep -q "Loading session"; then
            pass "$test_name - Session loaded without restart (same directory)"
            send_keys "exit"
            sleep 2
            stop_app
            return 0
        fi
        fail "$test_name - Restart not triggered when expected"
        stop_app
        return 1
    fi

    # Wait for DOSQ prompt
    if wait_for_pattern "Press Enter when ready" 30 "$log_file"; then
        log "DOSQ prompt appeared, pressing Enter"
        send_keys ""
        sleep 2
    else
        log "No DOSQ prompt, continuing anyway"
    fi

    # Wait for agent prompt after restart
    if wait_for_pattern "agent >>" 30 "$log_file"; then
        pass "$test_name - Restart successful, agent ready"
    else
        fail "$test_name - Agent not ready after restart"
        get_output >> "$log_file"
        stop_app
        return 1
    fi

    # Verify app is still running (not exited)
    get_output >> "$log_file"
    send_keys "what is the current working directory?"
    sleep 3
    get_output >> "$log_file"

    # Clean exit
    send_keys "exit"
    sleep 2
    stop_app
}

# =============================================================================
# Test 4: Load session and exit
# =============================================================================
test_load_and_exit() {
    local version="$1"
    local test_name="Test 4 ($version): Load session and exit"
    local log_file="$LOG_DIR/test4_${version}.log"

    log "$test_name"
    echo "=== $test_name ===" > "$log_file"

    # Start app
    start_app "$version" "/tmp"
    wait_for_pattern "agent >>" 45 "$log_file" || {
        fail "$test_name - App did not start"
        stop_app
        return 1
    }

    # Create a session by saying hello
    send_keys "hello"
    sleep 3
    get_output >> "$log_file"

    # Get session ID
    local session_id
    session_id=$(get_output | grep -oP 'Session:\s*\K[a-f0-9-]+' | head -1)
    log "Created session: $session_id"

    # Exit the app
    send_keys "exit"
    sleep 2

    # Start app again and load the session
    stop_app
    start_app "$version" "/tmp"
    wait_for_pattern "agent >>" 45 "$log_file" || {
        fail "$test_name - App did not start (second time)"
        stop_app
        return 1
    }

    # Load the session
    send_keys "/load $session_id"
    sleep 3
    get_output >> "$log_file"

    # Wait for DOSQ prompt
    if wait_for_pattern "Press Enter when ready" 20 "$log_file"; then
        log "DOSQ prompt appeared, pressing Enter"
        send_keys ""
        sleep 2
    else
        log "No DOSQ prompt, continuing anyway"
    fi

    # Wait for agent prompt
    wait_for_pattern "agent >>" 30 "$log_file" || {
        fail "$test_name - Agent not ready after session load"
        stop_app
        return 1
    }

    log "Session loaded, now exiting..."

    # Exit cleanly
    send_keys "exit"
    sleep 3
    get_output >> "$log_file"

    # Check if process exited
    local output
    output=$(get_output | tail -10)

    if echo "$output" | grep -qE "^\s*agent >>"; then
        fail "$test_name - App still running after exit command"
        log "Last output lines:"
        echo "$output" | head -5
    else
        pass "$test_name - App exited cleanly after session load"
    fi

    stop_app
}

# =============================================================================
# Main test runner
# =============================================================================
main() {
    log "========================================"
    log "Process Model Tests"
    log "========================================"
    log "Logs will be stored in: $LOG_DIR"
    log ""

    # Test live version (pnpm start)
    log "=== Testing LIVE version (pnpm start) ==="
    test_simple_exit "live"
    test_cwd "live"
    test_restart "live"
    test_load_and_exit "live"

    # Test installed version (mycc)
    log ""
    log "=== Testing INSTALLED version (mycc) ==="
    if command -v mycc &>/dev/null; then
        test_simple_exit "installed"
        test_cwd "installed"
        test_restart "installed"
        test_load_and_exit "installed"
    else
        log "${YELLOW}Skipping installed tests: mycc not found${NC}"
    fi

    # Summary
    log ""
    log "========================================"
    log "Test Summary"
    log "========================================"
    log "Passed: $TESTS_PASSED"
    log "Failed: $TESTS_FAILED"
    log "Logs: $LOG_DIR"

    if [ $TESTS_FAILED -eq 0 ]; then
        log "${GREEN}All tests passed!${NC}"
        exit 0
    else
        log "${RED}Some tests failed${NC}"
        exit 1
    fi
}

main "$@"