// Command mycc-daemon is a one-shot launcher that spawns the mycc daemon Lead
// (node.exe + tsx loader) with a HIDDEN console on Windows.
//
// Problem it solves:
//   The Coordinator spawns this wrapper with detached:true (DETACHED_PROCESS),
//   which gives the wrapper NO console. If the wrapper then spawned node.exe
//   the same way, the Lead would also have no console — and every cmd.exe the
//   Lead's execSync() calls spawn (shell:true default) would self-allocate a
//   VISIBLE console window that flashes on screen (~30 flashes per cron tick).
//
//   windowsHide:true on the spawn only hides the IMMEDIATE child's console,
//   not grandchildren's, and is ignored for console apps under DETACHED_PROCESS
//   (Node.js issue #21825). So per-call windowsHide is whack-a-mole.
//
// Solution:
//   This wrapper calls CreateProcessW directly with:
//     CREATE_NEW_CONSOLE         — gives the Lead its OWN console
//     STARTF_USESHOWWINDOW + SW_HIDE — hides that console
//
//   The Lead now has a hidden console. Every cmd.exe child it spawns sees the
//   inherited hidden console and does NOT self-allocate a new visible one.
//   Zero flashes, no per-call patching.
//
// Lifecycle:
//   Coordinator spawns wrapper (detached:true) → wrapper calls CreateProcessW
//   → wrapper exits immediately → Coordinator exits after grace period →
//   Lead runs independently with its hidden console. The console persists as
//   long as the Lead (or any descendant) is attached to it.
//
// Usage:
//   mycc-daemon.exe <node.exe path> <tsx loader path> <script path> [args...]
//
// Build (from src/native/daemon-wrapper):
//   go build -o ../../../bin/mycc-daemon.exe
//
// This is Windows-only. On Unix, the Coordinator uses spawnTsx directly
// (process groups, not consoles — no flash issue).
package main

import (
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

// Win32 process creation flags and constants.
const (
	createNewConsole    = 0x00000010 // CREATE_NEW_CONSOLE — child gets its own console
	startfUseShowWindow = 0x00000001 // STARTF_USESHOWWINDOW — wShowWindow is meaningful
	swHide              = 0          // SW_HIDE — hide the window
)

var (
	kernel32                       = syscall.NewLazyDLL("kernel32.dll")
	procCreateProcessW             = kernel32.NewProc("CreateProcessW")
	procGetExitCodeProcess         = kernel32.NewProc("GetExitCodeProcess")
	procCloseHandle                = kernel32.NewProc("CloseHandle")
	procWaitForSingleObject        = kernel32.NewProc("WaitForSingleObject")
)

// startupInfo is the Win32 STARTUPINFOW structure (Unicode).
// See: https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/ns-processthreadsapi-startupinfow
type startupInfo struct {
	cb              uint32
	lpReserved      *uint16
	lpDesktop       *uint16
	lpTitle         *uint16
	dwX             uint32
	dwY             uint32
	dwXSize         uint32
	dwYSize         uint32
	dwXCountChars   uint32
	dwYCountChars   uint32
	dwFillAttribute uint32
	dwFlags         uint32
	wShowWindow     uint16
	cbReserved2     uint16
	lpReserved2     *byte
	hStdInput       syscall.Handle
	hStdOutput      syscall.Handle
	hStdError       syscall.Handle
}

// processInformation is the Win32 PROCESS_INFORMATION structure.
type processInformation struct {
	hProcess    syscall.Handle
	hThread     syscall.Handle
	dwProcessID uint32
	dwThreadID  uint32
}

func main() {
	if len(os.Args) < 4 {
		fmt.Fprintln(os.Stderr, "mycc-daemon: usage: mycc-daemon.exe <node.exe> <tsx-loader> <script> [args...]")
		os.Exit(2)
	}

	nodePath := os.Args[1]
	loaderPath := os.Args[2]
	scriptPath := os.Args[3]
	extraArgs := os.Args[4:]

	// Build the command line:  node.exe --import <loader> <script> [args...]
	// CreateProcessW may mutate the command-line string, so build a mutable
	// UTF-16 buffer. Each token is quoted if it contains spaces; internal
	// double-quotes are escaped by doubling (Windows command-line convention).
	var cmdline []uint16
	appendToken := func(token string) {
		needsQuote := false
		for _, c := range token {
			if c == ' ' || c == '\t' {
				needsQuote = true
				break
			}
		}
		if needsQuote {
			cmdline = append(cmdline, '"')
		}
		for _, c := range token {
			if c == '"' {
				cmdline = append(cmdline, '"', '"') // escape " as ""
			} else {
				cmdline = append(cmdline, uint16(c))
			}
		}
		if needsQuote {
			cmdline = append(cmdline, '"')
		}
		cmdline = append(cmdline, ' ') // separator
	}

	appendToken(nodePath)
	appendToken("--import")
	appendToken(loaderPath)
	appendToken(scriptPath)
	for _, a := range extraArgs {
		appendToken(a)
	}
	// Trim trailing space, then null-terminate.
	if n := len(cmdline); n > 0 && cmdline[n-1] == ' ' {
		cmdline = cmdline[:n-1]
	}
	cmdline = append(cmdline, 0) // null terminator

	// STARTUPINFO: create a new console for the child, but hide it.
	si := startupInfo{
		cb:          uint32(unsafe.Sizeof(startupInfo{})),
		dwFlags:     startfUseShowWindow,
		wShowWindow: swHide,
	}
	var pi processInformation

	// CreateProcessW(
	//   lpApplicationName NULL,
	//   lpCommandLine     (mutable UTF-16),
	//   lpProcessAttributes NULL,
	//   lpThreadAttributes  NULL,
	//   bInheritHandles     FALSE  — daemon stdio is 'ignore', no handles to inherit,
	//   dwCreationFlags     CREATE_NEW_CONSOLE,
	//   lpEnvironment       NULL   — inherit parent's environment block,
	//   lpCurrentDirectory  NULL   — inherit parent's working directory,
	//   lpStartupInfo       &si,
	//   lpProcessInformation &pi,
	// )
	cmdlinePtr := &cmdline[0]
	ret, _, err := procCreateProcessW.Call(
		0,                                  // lpApplicationName
		uintptr(unsafe.Pointer(cmdlinePtr)), // lpCommandLine
		0,                                  // lpProcessAttributes
		0,                                  // lpThreadAttributes
		0,                                  // bInheritHandles = FALSE
		createNewConsole,                   // dwCreationFlags
		0,                                  // lpEnvironment = NULL (inherit)
		0,                                  // lpCurrentDirectory = NULL (inherit)
		uintptr(unsafe.Pointer(&si)),       // lpStartupInfo
		uintptr(unsafe.Pointer(&pi)),       // lpProcessInformation
	)
	if ret == 0 {
		fmt.Fprintf(os.Stderr, "mycc-daemon: CreateProcessW failed: %v\n", err)
		os.Exit(1)
	}

	// Close the thread handle immediately (we don't need it).
	procCloseHandle.Call(uintptr(pi.hThread))

	// One-shot launcher: we do NOT wait for the child. The child has its own
	// console (CREATE_NEW_CONSOLE) so it survives our exit. Print the PID so
	// the Coordinator can report it, then exit 0.
	fmt.Println(pi.dwProcessID)

	// Close the process handle (we don't keep it; the OS owns the child now).
	procCloseHandle.Call(uintptr(pi.hProcess))

	os.Exit(0)
}