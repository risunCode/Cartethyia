package api

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"testing"

	consolecontracts "github.com/cartethyia/daemon/internal/console/contracts"
)

func TestConsoleContractRouteParity(t *testing.T) {
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate console contract test source")
	}
	contractPath := filepath.Join(filepath.Dir(sourceFile), "..", "..", "..", "..", "contracts", "openapi", "console.yaml")
	contents, err := os.ReadFile(contractPath)
	if err != nil {
		t.Fatalf("read console contract %s: %v", contractPath, err)
	}
	documented, err := parseConsoleDocumentedRoutes(string(contents))
	if err != nil {
		t.Fatalf("parse documented console routes: %v", err)
	}
	registered := ConsoleRouteInventory()
	sortConsoleRoutes(registered)
	sortConsoleRoutes(documented)
	if len(registered) != len(documented) {
		t.Fatalf("console route count mismatch: registered=%v documented=%v", registered, documented)
	}
	for i := range registered {
		if registered[i] != documented[i] {
			t.Fatalf("console route drift at %d: registered=%v documented=%v", i, registered[i], documented[i])
		}
	}
}

func parseConsoleDocumentedRoutes(contents string) ([]ConsoleRoute, error) {
	var routes []ConsoleRoute
	var currentPath string
	inPaths := false
	seen := map[ConsoleRoute]bool{}
	for _, line := range strings.Split(contents, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "paths:" {
			inPaths = true
			continue
		}
		if !inPaths || trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		indent := len(line) - len(strings.TrimLeft(line, " "))
		if indent == 0 {
			break
		}
		if indent == 2 && strings.HasPrefix(trimmed, "/") && strings.HasSuffix(trimmed, ":") {
			currentPath = strings.TrimSuffix(trimmed, ":")
			continue
		}
		if indent == 4 && strings.HasSuffix(trimmed, ":") {
			method := strings.TrimSuffix(trimmed, ":")
			switch method {
			case "get", "post", "patch", "delete", "put", "options", "head", "trace":
				route := ConsoleRoute{Method: strings.ToUpper(method), Path: currentPath}
				if currentPath == "" || seen[route] {
					return nil, fmt.Errorf("invalid or duplicate route %v", route)
				}
				seen[route] = true
				routes = append(routes, route)
			}
		}
	}
	if len(routes) == 0 {
		return nil, fmt.Errorf("paths contains no operations")
	}
	return routes, nil
}

func sortConsoleRoutes(routes []ConsoleRoute) {
	sort.Slice(routes, func(i, j int) bool {
		if routes[i].Path == routes[j].Path {
			return routes[i].Method < routes[j].Method
		}
		return routes[i].Path < routes[j].Path
	})
}

func TestConsoleWireContractsExcludeTransportSecrets(t *testing.T) {
	types := []reflect.Type{
		reflect.TypeOf(consolecontracts.Account{}),
		reflect.TypeOf(consolecontracts.AccountInput{}),
		reflect.TypeOf(consolecontracts.AccountBatchPatch{}),
		reflect.TypeOf(consolecontracts.BatchResult{}),
		reflect.TypeOf(consolecontracts.QuotaState{}),
		reflect.TypeOf(consolecontracts.OAuthState{}),
		reflect.TypeOf(consolecontracts.RuntimeSettings{}),
		reflect.TypeOf(consolecontracts.RuntimeSettingsInput{}),
		reflect.TypeOf(consolecontracts.Session{}),
		reflect.TypeOf(consolecontracts.TelemetryQuery{}),
		reflect.TypeOf(consolecontracts.TelemetryOverview{}),
		reflect.TypeOf(consolecontracts.TelemetryBucket{}),
		reflect.TypeOf(consolecontracts.RequestDetail{}),
		reflect.TypeOf(consolecontracts.ConsoleLogQuery{}),
		reflect.TypeOf(consolecontracts.ConsoleLogEntry{}),
		reflect.TypeOf(consolecontracts.UsageSummary{}),
		reflect.TypeOf(consolecontracts.ClientDistribution{}),
		reflect.TypeOf(consolecontracts.ClientUsageItem{}),
		reflect.TypeOf(consolecontracts.CatalogProvider{}),
		reflect.TypeOf(consolecontracts.CatalogModel{}),
		reflect.TypeOf(consolecontracts.ProxyRecord{}),
		reflect.TypeOf(consolecontracts.ProxyInput{}),
		reflect.TypeOf(consolecontracts.InFlightRow{}),
		reflect.TypeOf(consolecontracts.BatchSubmitRequest{}),
		reflect.TypeOf(consolecontracts.BatchJob{}),
		reflect.TypeOf(consolecontracts.BatchItem{}),
		reflect.TypeOf(consolecontracts.BatchProgress{}),
	}
	for _, typ := range types {
		for i := 0; i < typ.NumField(); i++ {
			name := strings.ToLower(typ.Field(i).Name)
			for _, forbidden := range []string{"password", "cookie", "authorization", "header", "prompt", "body", "csrf", "secret", "credentialjson"} {
				if strings.Contains(name, forbidden) {
					t.Fatalf("%s contains transport-sensitive field %s", typ.Name(), typ.Field(i).Name)
				}
			}
		}
	}
}

func TestConsoleSetupSecretIsDedicatedAndConstrained(t *testing.T) {
	_, sourceFile, _, _ := runtime.Caller(0)
	contractPath := filepath.Join(filepath.Dir(sourceFile), "..", "..", "..", "..", "contracts", "openapi", "console.yaml")
	contents, err := os.ReadFile(contractPath)
	if err != nil {
		t.Fatal(err)
	}
	text := string(contents)
	for _, marker := range []string{"/share/setup/{token}", "x-console-security: one-shot-setup-secret", "MUST NOT be cached, logged, or reused", "This field is never present in monitor"} {
		if !strings.Contains(text, marker) {
			t.Fatalf("console contract missing setup-secret constraint %q", marker)
		}
	}
	if got := reflect.TypeOf(consolecontracts.ShareSetupResponse{}).Field(1).Name; got != "Key" {
		t.Fatalf("setup response key moved or renamed: %s", got)
	}
}
