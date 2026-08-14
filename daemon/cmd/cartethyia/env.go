package main

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// loadDotEnv loads the first .env found from the current directory or its
// parent. Existing process variables always win, so CI and service managers
// can override local development values without editing the file.
func loadDotEnv() error {
	for _, path := range []string{".env", filepath.Join("..", ".env")} {
		file, err := os.Open(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return fmt.Errorf("open dotenv %s: %w", path, err)
		}
		defer file.Close()
		scanner := bufio.NewScanner(file)
		line := 0
		for scanner.Scan() {
			line++
			if err := loadDotEnvLine(scanner.Text()); err != nil {
				return fmt.Errorf("parse dotenv %s:%d: %w", path, line, err)
			}
		}
		if err := scanner.Err(); err != nil {
			return fmt.Errorf("read dotenv %s: %w", path, err)
		}
		return nil
	}
	return nil
}

func loadDotEnvLine(line string) error {
	line = strings.TrimSpace(line)
	if line == "" || strings.HasPrefix(line, "#") {
		return nil
	}
	line = strings.TrimPrefix(line, "export ")
	key, value, ok := strings.Cut(line, "=")
	key = strings.TrimSpace(key)
	if !ok || key == "" {
		return fmt.Errorf("expected KEY=VALUE")
	}
	if strings.ContainsAny(key, " \t") {
		return fmt.Errorf("invalid key %q", key)
	}
	if _, exists := os.LookupEnv(key); exists {
		return nil
	}
	value = parseDotEnvValue(strings.TrimSpace(value))
	return os.Setenv(key, value)
}

func parseDotEnvValue(value string) string {
	if len(value) >= 2 && value[0] == '"' && value[len(value)-1] == '"' {
		if unquoted, err := strconv.Unquote(value); err == nil {
			return unquoted
		}
	}
	if len(value) >= 2 && value[0] == '\'' && value[len(value)-1] == '\'' {
		return value[1 : len(value)-1]
	}
	if index := strings.Index(value, " #"); index >= 0 {
		value = value[:index]
	}
	return strings.TrimSpace(value)
}
