package proxy

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
	daemonRoot := filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", ".."))
	required := []string{
		filepath.Join(daemonRoot, "internal", "proxy", "runtime"),
		filepath.Join(daemonRoot, "internal", "proxy", "protocol", "contracts"),
		filepath.Join(daemonRoot, "internal", "proxy", "protocol", "transforms"),
		filepath.Join(daemonRoot, "internal", "runtime", "cache"),
		filepath.Join(daemonRoot, "internal", "accounts", "drivers"),
		filepath.Join(daemonRoot, "internal", "server", "api"),
		filepath.Join(daemonRoot, "internal", "database", "models"),
		filepath.Join(daemonRoot, "internal", "providers", "adapters"),
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
	err := filepath.WalkDir(daemonRoot, func(path string, entry os.DirEntry, walkErr error) error {
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
			pkg := task1Module + "/" + filepath.ToSlash(strings.TrimPrefix(filepath.Dir(path), daemonRoot+string(filepath.Separator)))
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
		{Importer: task1Module + "/internal/proxy/runtime", Forbidden: []string{task1Module + "/internal/server/api", task1Module + "/internal/server/apierrors", task1Module + "/internal/server/admin", task1Module + "/internal/server/middleware"}},
		{Importer: task1Module + "/internal/proxy/protocol/transforms", Forbidden: []string{task1Module + "/internal/database", task1Module + "/internal/server", task1Module + "/internal/proxy/transport", task1Module + "/internal/providers/adapters"}},
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
		task1Module + "/internal/proxy/protocol/contracts",
		task1Module + "/internal/proxy/protocol/transforms",
		task1Module + "/internal/providers",
		task1Module + "/internal/accounts",
		task1Module + "/internal/observability",
	} {
		t.Logf("package baseline owner=%s production_importers=%d", owner, len(fanIn[owner]))
	}
	t.Logf("package baseline production_packages=%d", len(packages))
}
