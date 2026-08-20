//go:build ignore

package main

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

func main() {
	cmd := exec.Command("go", "test", "./...", "-coverprofile=cover.out", "-count=1")
	out, err := cmd.CombinedOutput()
	if err != nil {
		fmt.Printf("go test failed:\n%s\n", out)
		os.Exit(1)
	}

	cmdFunc := exec.Command("go", "tool", "cover", "-func=cover.out")
	funcOut, err := cmdFunc.Output()
	if err != nil {
		fmt.Printf("go tool cover failed: %v\n", err)
		os.Exit(1)
	}

	scanner := bufio.NewScanner(strings.NewReader(string(funcOut)))
	var totalPct float64
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "total:") {
			fields := strings.Fields(line)
			if len(fields) >= 3 {
				pctStr := strings.TrimSuffix(fields[len(fields)-1], "%")
				totalPct, _ = strconv.ParseFloat(pctStr, 64)
			}
		}
	}

	fmt.Printf("=== Router Hardening Coverage Report ===\n")
	fmt.Printf("Total Statement Coverage: %.1f%%\n", totalPct)
	if totalPct < 60.0 {
		fmt.Printf("FAIL: total coverage below minimum threshold (60.0%%)\n")
		os.Exit(1)
	}
	fmt.Println("Coverage Check: PASS")
}
