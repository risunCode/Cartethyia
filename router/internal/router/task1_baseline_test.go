package router

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

const task1Module = "github.com/cartethyia/daemon"

type task1ImportRule struct {
	Importer  string
	Forbidden []string
}

// TestTask1PackageImportBaseline records the package inventory and import fan-in
// for the cleanup baseline while guarding the two request-path directions that
// must remain narrow. It reads production Go files only, so test scaffolding and
// generated benchmark helpers do not alter the architectural measurement.
func TestTask1PackageImportBaseline(t *testing.T) {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate baseline source")
	}
	routerRoot := filepath.Clean(filepath.Join(filepath.Dir(file), "..", ".."))
	required := []string{
		filepath.Join(routerRoot, "internal", "app"),
		filepath.Join(routerRoot, "internal", "gateway"),
		filepath.Join(routerRoot, "internal", "protocol"),
		filepath.Join(routerRoot, "internal", "protocol", "codec"),
		filepath.Join(routerRoot, "internal", "router"),
		filepath.Join(routerRoot, "internal", "router", "cache"),
		filepath.Join(routerRoot, "internal", "providers"),
		filepath.Join(routerRoot, "internal", "providers", "adapters"),
		filepath.Join(routerRoot, "internal", "accounts"),
		filepath.Join(routerRoot, "internal", "accounts", "auth"),
		filepath.Join(routerRoot, "internal", "egress"),
		filepath.Join(routerRoot, "internal", "console"),
		filepath.Join(routerRoot, "internal", "storage"),
		filepath.Join(routerRoot, "internal", "storage", "models"),
		filepath.Join(routerRoot, "internal", "telemetry"),
	}
	for _, path := range required {
		if info, err := os.Stat(path); err != nil || !info.IsDir() {
			t.Fatalf("baseline owner directory missing: %s", path)
		}
	}

	packages := make(map[string]struct{})
	fanIn := make(map[string]map[string]struct{})
	importsByPackage := make(map[string]map[string]struct{})
	files := token.NewFileSet()
	err := filepath.WalkDir(routerRoot, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			if entry.Name() == ".git" || entry.Name() == "vendor" {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.Type().IsRegular() && filepath.Ext(path) == ".go" && !strings.HasSuffix(path, "_test.go") {
			pkg := task1Module + "/" + filepath.ToSlash(strings.TrimPrefix(filepath.Dir(path), routerRoot+string(filepath.Separator)))
			packages[pkg] = struct{}{}
			fileAST, parseErr := parser.ParseFile(files, path, nil, parser.ImportsOnly)
			if parseErr != nil {
				return parseErr
			}
			for _, spec := range fileAST.Imports {
				importPath := strings.Trim(spec.Path.Value, `"`)
				if importsByPackage[pkg] == nil {
					importsByPackage[pkg] = make(map[string]struct{})
				}
				importsByPackage[pkg][importPath] = struct{}{}
				if fanIn[importPath] == nil {
					fanIn[importPath] = make(map[string]struct{})
				}
				fanIn[importPath][pkg] = struct{}{}
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(packages) == 0 {
		t.Fatal("production package inventory is empty")
	}

	rules := []task1ImportRule{
		{Importer: task1Module + "/internal/router", Forbidden: []string{task1Module + "/internal/gateway/api", task1Module + "/internal/gateway/apierrors", task1Module + "/internal/console/api", task1Module + "/internal/gateway/middleware"}},
		{Importer: task1Module + "/internal/protocol/codec", Forbidden: []string{task1Module + "/internal/storage", task1Module + "/internal/egress", task1Module + "/internal/providers/adapters"}},
	}
	for _, rule := range rules {
		for forbidden := range importsByPackage[rule.Importer] {
			for _, prefix := range rule.Forbidden {
				if forbidden == prefix || strings.HasPrefix(forbidden, prefix+"/") {
					t.Fatalf("baseline import direction violation: %s imports %s", rule.Importer, forbidden)
				}
			}
		}
	}

	for _, owner := range []string{
		task1Module + "/internal/protocol",
		task1Module + "/internal/protocol/codec",
		task1Module + "/internal/providers",
		task1Module + "/internal/accounts/auth",
		task1Module + "/internal/telemetry",
	} {
		t.Logf("package baseline owner=%s production_importers=%d", owner, len(fanIn[owner]))
	}
	t.Logf("package baseline production_packages=%d", len(packages))
}
