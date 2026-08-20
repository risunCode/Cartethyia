package main

import (
	"os"
	"strconv"
	"testing"
)

func TestParseDotEnvValue(t *testing.T) {
	if got := parseDotEnvValue(`"postgres://user:p#ass@127.0.0.1/db"`); got != "postgres://user:p#ass@127.0.0.1/db" {
		t.Fatalf("quoted value = %q", got)
	}
	if got := parseDotEnvValue("redis://127.0.0.1:6379/0 # local Redis"); got != "redis://127.0.0.1:6379/0" {
		t.Fatalf("comment value = %q", got)
	}
}

func TestLoadDotEnvLineDoesNotOverrideProcessEnvironment(t *testing.T) {
	key := "CARTETHYIA_DOTENV_TEST_" + strconv.Itoa(os.Getpid())
	t.Setenv(key, "process-value")
	if err := loadDotEnvLine(key + "=file-value"); err != nil {
		t.Fatal(err)
	}
	if got := os.Getenv(key); got != "process-value" {
		t.Fatalf("environment value = %q", got)
	}
}
