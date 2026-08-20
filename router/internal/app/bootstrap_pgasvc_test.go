package app

import (
	"testing"

	consoleservices "github.com/cartethyia/daemon/internal/console/services"
)

func TestConsoleServicesWithoutDependencies(t *testing.T) {
	svc, err := consoleservices.BuildServices(consoleservices.BuildInput{})
	if err != nil {
		t.Fatalf("build services: %v", err)
	}
	if svc.Accounts != nil || svc.Dashboard != nil {
		t.Fatalf("expected empty services, got %+v", svc)
	}
	if svc.Telemetry != nil || svc.Usage != nil || svc.ConsoleLogs != nil || svc.Catalog != nil || svc.InFlightStats != nil {
		t.Fatalf("expected no composed services without a database, got %+v", svc)
	}
}
