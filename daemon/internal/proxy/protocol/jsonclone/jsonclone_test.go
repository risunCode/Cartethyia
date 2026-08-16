package jsonclone

import (
	"reflect"
	"testing"
)

func TestCloneMapNil(t *testing.T) {
	if got := CloneMap(nil); got != nil {
		t.Fatalf("CloneMap(nil) = %v, want nil", got)
	}
}

func TestCloneMapIndependence(t *testing.T) {
	src := map[string]any{"a": "1", "b": 2}
	dst := CloneMap(src)
	if !reflect.DeepEqual(dst, src) {
		t.Fatalf("clone contents differ: got %v want %v", dst, src)
	}
	dst["a"] = "mutated"
	if src["a"] != "1" {
		t.Fatalf("CloneMap did not isolate source: src[a] = %v", src["a"])
	}
}

func TestCloneMapNestedShallow(t *testing.T) {
	nested := map[string]any{"k": "v"}
	src := map[string]any{"inner": nested}
	dst := CloneMap(src)
	dst["inner"].(map[string]any)["k"] = "mutated"
	if nested["k"] != "mutated" {
		t.Fatalf("CloneMap must be shallow; nested map should share identity, got %v", nested["k"])
	}
}

func TestCloneMapListEmpty(t *testing.T) {
	if got := CloneMapList(nil); got != nil {
		t.Fatalf("CloneMapList(nil) = %v, want nil", got)
	}
	if got := CloneMapList([]map[string]any{}); got != nil {
		t.Fatalf("CloneMapList([]) = %v, want nil", got)
	}
}

func TestCloneMapListIndependence(t *testing.T) {
	src := []map[string]any{{"x": 1}, {"y": 2}}
	dst := CloneMapList(src)
	if len(dst) != len(src) {
		t.Fatalf("length mismatch: got %d want %d", len(dst), len(src))
	}
	dst[0]["x"] = 99
	if src[0]["x"] != 1 {
		t.Fatalf("CloneMapList must isolate elements: src[0][x] = %v", src[0]["x"])
	}
	dst[1]["new"] = "added"
	if _, ok := src[1]["new"]; ok {
		t.Fatalf("CloneMapList must not alias sibling elements")
	}
}

func TestCloneValueScalar(t *testing.T) {
	if got := CloneValue("hello"); got != "hello" {
		t.Fatalf("CloneValue(string) = %v", got)
	}
	if got := CloneValue(42); got != 42 {
		t.Fatalf("CloneValue(int) = %v", got)
	}
	if got := CloneValue(nil); got != nil {
		t.Fatalf("CloneValue(nil) = %v", got)
	}
}

func TestCloneValueMap(t *testing.T) {
	src := map[string]any{"a": "x"}
	dst := CloneValue(src).(map[string]any)
	dst["a"] = "y"
	if src["a"] != "x" {
		t.Fatalf("CloneValue(map) not independent")
	}
}

func TestCloneValueMapListBecomesAnySlice(t *testing.T) {
	src := []map[string]any{{"a": 1}, {"b": 2}}
	dst := CloneValue(src).([]any)
	if len(dst) != 2 {
		t.Fatalf("expected []any length 2, got %d", len(dst))
	}
	dst[0].(map[string]any)["a"] = 99
	if src[0]["a"] != 1 {
		t.Fatalf("CloneValue([]map[string]any) must clone inner maps: src[0][a] = %v", src[0]["a"])
	}
}

func TestCloneValueAnySlice(t *testing.T) {
	inner := map[string]any{"k": "v"}
	src := []any{inner, "scalar", 7}
	dst := CloneValue(src).([]any)
	if len(dst) != 3 {
		t.Fatalf("length mismatch: %d", len(dst))
	}
	dst[0].(map[string]any)["k"] = "mutated"
	if inner["k"] != "v" {
		t.Fatalf("CloneValue([]any) must clone inner maps: inner[k] = %v", inner["k"])
	}
	if dst[1] != "scalar" {
		t.Fatalf("scalar passthrough broken")
	}
	if dst[2] != 7 {
		t.Fatalf("int passthrough broken")
	}
}
