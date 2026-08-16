package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"regexp"
	"strings"

	"github.com/cartethyia/daemon"
)

const (
	ExitSuccess             = 0
	ExitConfiguration       = 2
	ExitDependency          = 3
	ExitRouteUnavailable    = 4
	ExitProtocolFailure     = 5
	ExitTimeout             = 6
	ExitAuthorizationFailed = 7
	ExitScoreFailure        = 8
	ExitTier0Failure        = 9
)

type daemonRuntime interface {
	Start(context.Context) error
	Close(context.Context) error
}

var (
	loadDaemonConfig = daemon.LoadConfig
	newDaemonRuntime = func(cfg daemon.Config) (daemonRuntime, error) { return daemon.New(cfg) }
	runDoctor        = daemon.Doctor
	explainRoute     = daemon.ExplainRoute
)

type commandFailure struct {
	OK      bool   `json:"ok"`
	Command string `json:"command"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

func run(ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if ctx == nil {
		ctx = context.Background()
	}
	if stdin == nil {
		stdin = strings.NewReader("")
	}
	if stdout == nil {
		stdout = io.Discard
	}
	if stderr == nil {
		stderr = io.Discard
	}
	if hasSecretValuedFlag(args) {
		return writeFailure(stdout, stderr, false, "cli", ExitConfiguration, "configuration_failure", "secret-valued flags are not accepted")
	}
	if err := loadDotEnv(); err != nil {
		return writeFailure(stdout, stderr, wantsJSON(args), commandName(args), ExitConfiguration, "configuration_failure", "dotenv loading failed")
	}
	if len(args) == 0 {
		return serveCommand(ctx, nil, stdout, stderr)
	}
	switch args[0] {
	case "serve":
		return serveCommand(ctx, args[1:], stdout, stderr)
	case "doctor":
		return doctorCommand(ctx, args[1:], stdout, stderr)
	case "route":
		return routeCommand(ctx, args[1:], stdout, stderr)
	case "probe":
		return probeCommand(ctx, args[1:], stdin, stdout, stderr)
	case "compat":
		return compatCommand(ctx, args[1:], stdin, stdout, stderr)
	case "cache":
		return cacheCommand(ctx, args[1:], stdout, stderr)
	case "accounts":
		return accountsCommand(ctx, args[1:], stdout, stderr)
	default:
		return writeFailure(stdout, stderr, wantsJSON(args), "cli", ExitConfiguration, "configuration_failure", "unknown command")
	}
}

func serveCommand(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	flags := newFlagSet("serve")
	jsonOutput := flags.Bool("json", false, "emit JSON errors")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		return writeFailure(stdout, stderr, value(jsonOutput), "serve", ExitConfiguration, "configuration_failure", "invalid serve arguments")
	}
	cfg, err := loadDaemonConfig()
	if err != nil {
		return writeFailure(stdout, stderr, *jsonOutput, "serve", ExitConfiguration, "configuration_failure", "configuration validation failed")
	}
	runtime, err := newDaemonRuntime(cfg)
	if err != nil {
		return writeFailure(stdout, stderr, *jsonOutput, "serve", ExitDependency, "dependency_failure", "runtime construction failed: "+err.Error())
	}
	defer func() { _ = runtime.Close(context.Background()) }()
	if err := runtime.Start(ctx); err != nil && !errors.Is(err, context.Canceled) {
		return writeFailure(stdout, stderr, *jsonOutput, "serve", ExitDependency, "dependency_failure", "daemon serving failed: "+err.Error())
	}
	return ExitSuccess
}

func doctorCommand(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	flags := newFlagSet("doctor")
	jsonOutput := flags.Bool("json", false, "emit JSON")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		return writeFailure(stdout, stderr, value(jsonOutput), "doctor", ExitConfiguration, "configuration_failure", "invalid doctor arguments")
	}
	cfg, err := loadDaemonConfig()
	if err != nil {
		return writeFailure(stdout, stderr, *jsonOutput, "doctor", ExitConfiguration, "configuration_failure", "configuration validation failed")
	}
	report, err := runDoctor(ctx, cfg)
	if err != nil {
		return writeFailure(stdout, stderr, *jsonOutput, "doctor", ExitDependency, "dependency_failure", "one or more dependency checks failed")
	}
	if *jsonOutput {
		_ = json.NewEncoder(stdout).Encode(struct {
			OK      bool                     `json:"ok"`
			Command string                   `json:"command"`
			Checks  []daemon.DiagnosticCheck `json:"checks"`
		}{OK: true, Command: "doctor", Checks: report.Checks})
	} else {
		for _, check := range report.Checks {
			if check.Detail == "" {
				fmt.Fprintf(stdout, "%-22s %s\n", check.Name, check.Status)
			} else {
				fmt.Fprintf(stdout, "%-22s %s (%s)\n", check.Name, check.Status, check.Detail)
			}
		}
	}
	return ExitSuccess
}

func routeCommand(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 || args[0] != "explain" {
		return writeFailure(stdout, stderr, wantsJSON(args), "route explain", ExitConfiguration, "configuration_failure", "route requires the explain subcommand")
	}
	flags := newFlagSet("route explain")
	model := flags.String("model", "", "requested model")
	surface := flags.String("surface", "", "client surface")
	jsonOutput := flags.Bool("json", false, "emit JSON")
	if err := flags.Parse(args[1:]); err != nil || flags.NArg() != 0 || strings.TrimSpace(*model) == "" || !validProbeSurface(*surface) {
		return writeFailure(stdout, stderr, value(jsonOutput), "route explain", ExitConfiguration, "configuration_failure", "--model and a supported --surface are required")
	}
	cfg, err := loadDaemonConfig()
	if err != nil {
		return writeFailure(stdout, stderr, *jsonOutput, "route explain", ExitConfiguration, "configuration_failure", "configuration validation failed")
	}
	report, err := explainRoute(ctx, cfg, *model, *surface)
	if err != nil && strings.HasPrefix(err.Error(), "diagnostics:") {
		return writeFailure(stdout, stderr, *jsonOutput, "route explain", ExitDependency, "dependency_failure", "route dependencies are unavailable")
	}
	if err != nil || len(report.Candidates) == 0 {
		return writeFailure(stdout, stderr, *jsonOutput, "route explain", ExitRouteUnavailable, "route_unavailable", "no usable route is available")
	}
	if *jsonOutput {
		_ = json.NewEncoder(stdout).Encode(struct {
			OK      bool                    `json:"ok"`
			Command string                  `json:"command"`
			Route   daemon.RouteExplanation `json:"route"`
		}{OK: true, Command: "route explain", Route: report})
	} else {
		fmt.Fprintf(stdout, "route %s (%s, generation %d)\n", report.RequestedModel, report.Strategy, report.Generation)
		for _, candidate := range report.Candidates {
			fmt.Fprintf(stdout, "%d. %s/%s account=%s state=%s\n", candidate.Position, candidate.ProviderID, candidate.UpstreamModel, candidate.AccountID, candidate.State)
		}
		for _, exclusion := range report.Exclusions {
			fmt.Fprintf(stdout, "excluded %s %s: %s\n", exclusion.Kind, exclusion.ID, exclusion.Reason)
		}
		for _, proxy := range report.Proxies {
			fmt.Fprintf(stdout, "proxy %s: %s", proxy.ID, proxy.State)
			if proxy.Reason != "" {
				fmt.Fprintf(stdout, " (%s)", proxy.Reason)
			}
			fmt.Fprintln(stdout)
		}
	}
	return ExitSuccess
}

func newFlagSet(name string) *flag.FlagSet {
	flags := flag.NewFlagSet(name, flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	return flags
}

func value(value *bool) bool { return value != nil && *value }

func writeFailure(stdout, stderr io.Writer, jsonOutput bool, command string, exit int, code, message string) int {
	failure := commandFailure{OK: false, Command: command, Code: code, Message: message}
	if jsonOutput {
		_ = json.NewEncoder(stdout).Encode(failure)
	} else {
		fmt.Fprintf(stderr, "%s: %s\n", command, message)
	}
	return exit
}

func commandName(args []string) string {
	if len(args) == 0 {
		return "serve"
	}
	if args[0] == "route" && len(args) > 1 && args[1] == "explain" {
		return "route explain"
	}
	if args[0] == "compat" && len(args) > 1 {
		return "compat " + args[1]
	}
	if args[0] == "cache" && len(args) > 1 {
		return "cache " + args[1]
	}
	if args[0] == "accounts" && len(args) > 1 {
		return "accounts " + args[1]
	}
	return args[0]
}

func wantsJSON(args []string) bool {
	for _, arg := range args {
		if arg == "--json" {
			return true
		}
	}
	return false
}

var safeEnvironmentName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

func hasSecretValuedFlag(args []string) bool {
	for _, arg := range args {
		name := strings.ToLower(strings.TrimSpace(strings.SplitN(arg, "=", 2)[0]))
		switch name {
		case "--secret", "--token", "--access-token", "--auth-token", "--key", "--api-key", "--apikey", "--credential", "--password", "--authorization", "--bearer":
			return true
		}
	}
	return false
}

func validProbeSurface(surface string) bool {
	switch surface {
	case "openai-chat", "openai-responses", "anthropic-messages":
		return true
	default:
		return false
	}
}
