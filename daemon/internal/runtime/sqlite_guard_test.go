package runtime

import (
	"bufio"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

// TestDaemonProductionSourceHasNoSQLiteAuthority is an inventory guard for
// the production daemon tree. SQLite and runtime.db are intentionally absent
// from the runtime authority; adding one requires an explicit development-only
// boundary instead of silently creating a second durable store.
func TestDaemonProductionSourceHasNoSQLiteAuthority(t *testing.T) {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(file), "..", ".."))
	forbidden := []string{"runtime.db", "sqlite3", "modernc.org/sqlite", "mattn/go-sqlite3"}
	var violations []string
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".go") || strings.HasSuffix(entry.Name(), "_test.go") {
			return nil
		}
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		defer file.Close()
		scanner := bufio.NewScanner(file)
		line := 0
		for scanner.Scan() {
			line++
			text := strings.ToLower(scanner.Text())
			for _, needle := range forbidden {
				if strings.Contains(text, needle) {
					violations = append(violations, path+":"+strconv.Itoa(line)+" contains "+needle)
				}
			}
		}
		return scanner.Err()
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(violations) > 0 {
		t.Fatalf("production SQLite/runtime.db authority detected: %s", strings.Join(violations, "; "))
	}
}
