package runtime

import "testing"

func TestPostgresAdminServicesNilDatabase(t *testing.T) {
	svc := postgresAdminServices(BootstrapDependencies{})
	if svc.APIKeys != nil || svc.Proxies != nil || svc.Accounts != nil || svc.Dashboard != nil {
		t.Fatalf("expected empty services, got %+v", svc)
	}
}