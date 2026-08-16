package runtime

import "testing"

func TestPostgresAdminServicesNilDatabase(t *testing.T) {
	svc := postgresAdminServices(BootstrapDependencies{}, adminServiceWiring{})
	if svc.Accounts != nil || svc.Dashboard != nil {
		t.Fatalf("expected empty services, got %+v", svc)
	}
	if svc.Telemetry != nil || svc.Usage != nil || svc.ConsoleLogs != nil || svc.Catalog != nil || svc.InFlightStats != nil {
		t.Fatalf("expected no composed services without a database, got %+v", svc)
	}
}
