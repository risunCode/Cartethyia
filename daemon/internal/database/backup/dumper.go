package backup

import (
	"context"
	"errors"
	"fmt"
	"io"
)

// Dumper produces a PostgreSQL dump as a stream.
//
// Implementations must respect ctx cancellation: when the context fires, the
// returned reader MUST return an error from Read and any underlying subprocess
// MUST be terminated.
type Dumper interface {
	// Dump launches the dump process and returns its standard output as a
	// stream that the caller consumes. The returned closer releases any
	// resources (subprocess handles, temp files) when the consumer is done;
	// it MUST be safe to call multiple times.
	Dump(ctx context.Context) (io.ReadCloser, error)
}

// Command describes a single subprocess invocation. All fields are
// caller-controlled; the dumper does not assume any default binary path or
// environment variable.
type Command struct {
	// Path is the executable to launch. Must be non-empty.
	Path string
	// Args are passed verbatim to the executable.
	Args []string
	// Env is appended to the parent process environment.
	Env []string
	// Stdin may be supplied to feed commands into psql-style tools.
	Stdin io.Reader
}

// CommandRunner executes a Command and exposes its stdout. Implementations
// are injected so tests can supply a fake without spawning a real subprocess.
type CommandRunner interface {
	// Run starts the command and returns a reader over its stdout together
	// with a closer that terminates the process and waits for it to exit.
	Run(ctx context.Context, cmd Command) (io.ReadCloser, error)
}

// PostgresDumper is a Dumper that shells out to a single Command per dump.
//
// Connection parameters and credentials are passed through cmd.Env so no
// connection string is hardcoded here. Callers populate Env from
// configuration; the dumper does not read any environment on its own.
type PostgresDumper struct {
	// Runner executes the configured command. Required.
	Runner CommandRunner
	// Command is the executable to invoke.
	Command Command
	// Stdin is the SQL input piped into the tool. Optional.
	Stdin io.Reader
}

// Dump executes the configured command and returns its stdout.
func (d *PostgresDumper) Dump(ctx context.Context) (io.ReadCloser, error) {
	if d == nil {
		return nil, errors.New("backup: nil PostgresDumper")
	}
	if d.Runner == nil {
		return nil, errors.New("backup: PostgresDumper.Runner is nil")
	}
	if d.Command.Path == "" {
		return nil, errors.New("backup: PostgresDumper.Command.Path is empty")
	}
	cmd := d.Command
	if d.Stdin != nil {
		cmd.Stdin = d.Stdin
	}
	reader, err := d.Runner.Run(ctx, cmd)
	if err != nil {
		return nil, newStageError(StageDump, 1, fmt.Errorf("spawn %s: %w", cmd.Path, err))
	}
	return reader, nil
}
