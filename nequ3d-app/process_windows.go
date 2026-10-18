package main

import (
	"os/exec"
	"syscall"
)

// Keep telemetry subprocesses from opening a console in the desktop app.
func configureBackgroundCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x08000000, // CREATE_NO_WINDOW
	}
}
