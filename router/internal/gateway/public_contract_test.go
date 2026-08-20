package gateway

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
)

func TestPublicContractRouteParity(t *testing.T) {
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate public contract test source")
	}
	contractPath := filepath.Join(filepath.Dir(sourceFile), "..", "..", "..", "contracts", "openapi", "public.yaml")
	contents, err := os.ReadFile(contractPath)
	if err != nil {
		t.Fatalf("read public contract %s: %v", contractPath, err)
	}

	documented, err := parseDocumentedRoutes(string(contents))
	if err != nil {
		t.Fatalf("parse documented public routes: %v", err)
	}
	registered := PublicRouteInventory()
	sortRoutes(registered)
	sortRoutes(documented)
	if len(registered) != len(documented) {
		t.Fatalf("public route count mismatch: registered=%v documented=%v", registered, documented)
	}
	for i := range registered {
		if registered[i] != documented[i] {
			t.Fatalf("public route mismatch at %d: registered=%v documented=%v", i, registered[i], documented[i])
		}
	}
}

func parseDocumentedRoutes(contents string) ([]PublicRoute, error) {
	var routes []PublicRoute
	var currentPath string
	inPaths := false
	seen := map[string]bool{}
	for _, line := range strings.Split(contents, "\n") {
		if strings.TrimSpace(line) == "paths:" {
			inPaths = true
			continue
		}
		if !inPaths {
			continue
		}
		if line != "" && line[0] != ' ' && line[0] != '\t' {
			break
		}
		if strings.HasPrefix(line, "  /") || strings.HasPrefix(line, `  "/`) {
			key := strings.TrimSpace(line)
			if !strings.HasSuffix(key, ":") {
				return nil, fmt.Errorf("path key lacks colon: %q", line)
			}
			currentPath = strings.TrimSuffix(key, ":")
			if len(currentPath) >= 2 && currentPath[0] == '"' && currentPath[len(currentPath)-1] == '"' {
				currentPath = currentPath[1 : len(currentPath)-1]
			}
			continue
		}
		if currentPath == "" || !strings.HasPrefix(line, "    ") || strings.HasPrefix(line, "      ") {
			continue
		}
		method := strings.TrimSpace(line)
		if !strings.HasSuffix(method, ":") {
			continue
		}
		method = strings.TrimSuffix(method, ":")
		switch method {
		case "get", "post", "put", "patch", "delete", "head", "options", "trace":
		default:
			continue
		}
		route := PublicRoute{Method: strings.ToUpper(method), Path: currentPath}
		key := route.Method + " " + route.Path
		if seen[key] {
			return nil, fmt.Errorf("duplicate documented route %s", key)
		}
		seen[key] = true
		routes = append(routes, route)
	}
	if len(routes) == 0 {
		return nil, fmt.Errorf("paths contains no operations")
	}
	return routes, nil
}

func sortRoutes(routes []PublicRoute) {
	sort.Slice(routes, func(i, j int) bool {
		if routes[i].Path == routes[j].Path {
			return routes[i].Method < routes[j].Method
		}
		return routes[i].Path < routes[j].Path
	})
}
