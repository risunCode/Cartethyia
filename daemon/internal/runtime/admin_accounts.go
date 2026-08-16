package runtime

import (
	"context"
	"errors"

	"github.com/cartethyia/daemon/internal/accounts"
	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
	admin "github.com/cartethyia/daemon/internal/server/admin"
)

type postgresAccountAdminService struct {
	accounts  accounts.AccountConfigStore
	records   accounts.RecordStore
	secrets   accounts.SecretStore
	refresher accounts.Refresher
}

func (s *postgresAccountAdminService) List(ctx context.Context, providerID string) ([]contracts.Account, error) {
	configs, err := s.accounts.List(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]contracts.Account, 0, len(configs))
	for _, cfg := range configs {
		if cfg == nil || (providerID != "" && cfg.ProviderID != providerID) {
			continue
		}
		out = append(out, s.project(ctx, cfg))
	}
	return out, nil
}

func (s *postgresAccountAdminService) Create(ctx context.Context, providerID string, input admin.AccountInput) (contracts.Account, error) {
	id, err := randomAdminID("account")
	if err != nil {
		return contracts.Account{}, err
	}
	enabled := true
	if input.Enabled != nil {
		enabled = *input.Enabled
	}
	ref, err := accounts.NewReference(input.CredentialRef)
	if err != nil && input.CredentialRef != "" {
		return contracts.Account{}, err
	}
	cfg := &accounts.AccountConfig{ID: id, ProviderID: providerID, Kind: accounts.KindAPIKey, Enabled: enabled, CredentialRef: ref}
	if input.Name != "" {
		cfg.Labels = map[string]string{"name": input.Name}
	}
	if input.Label != "" {
		if cfg.Labels == nil {
			cfg.Labels = map[string]string{}
		}
		cfg.Labels["label"] = input.Label
	}
	if err := s.accounts.Put(ctx, cfg); err != nil {
		return contracts.Account{}, err
	}
	return s.project(ctx, cfg), nil
}

func (s *postgresAccountAdminService) Update(ctx context.Context, providerID, accountID string, input admin.AccountInput) (contracts.Account, error) {
	cfg, err := s.accounts.Get(ctx, accountID)
	if err != nil {
		return contracts.Account{}, err
	}
	if cfg.ProviderID != providerID {
		return contracts.Account{}, errors.New("account provider mismatch")
	}
	if input.Enabled != nil {
		cfg.Enabled = *input.Enabled
	}
	if input.CredentialRef != "" {
		ref, refErr := accounts.NewReference(input.CredentialRef)
		if refErr != nil {
			return contracts.Account{}, refErr
		}
		cfg.CredentialRef = ref
	}
	if input.Label != "" || input.Name != "" {
		if cfg.Labels == nil {
			cfg.Labels = map[string]string{}
		}
		if input.Label != "" {
			cfg.Labels["label"] = input.Label
		}
		if input.Name != "" {
			cfg.Labels["name"] = input.Name
		}
	}
	if err := s.accounts.Put(ctx, cfg); err != nil {
		return contracts.Account{}, err
	}
	return s.project(ctx, cfg), nil
}

func (s *postgresAccountAdminService) Delete(ctx context.Context, providerID, accountID string) error {
	cfg, err := s.accounts.Get(ctx, accountID)
	if err != nil {
		return err
	}
	if cfg.ProviderID != providerID {
		return errors.New("account provider mismatch")
	}
	if err := s.accounts.Delete(ctx, accountID); err != nil {
		return err
	}
	if s.records != nil {
		_ = s.records.Delete(ctx, accountID)
	}
	if s.secrets != nil {
		_ = s.secrets.Delete(ctx, accountID)
	}
	return nil
}

func (s *postgresAccountAdminService) BatchCreate(ctx context.Context, providerID string, items []admin.AccountInput) ([]contracts.Account, error) {
	out := make([]contracts.Account, 0, len(items))
	for _, item := range items {
		account, err := s.Create(ctx, providerID, item)
		if err != nil {
			return out, err
		}
		out = append(out, account)
	}
	return out, nil
}

func (s *postgresAccountAdminService) BatchDelete(ctx context.Context, providerID string, ids []string) (admin.BatchResult, error) {
	result := admin.BatchResult{Processed: len(ids)}
	for _, id := range ids {
		if err := s.Delete(ctx, providerID, id); err != nil {
			result.Failed++
			result.Errors = append(result.Errors, id+": "+err.Error())
			continue
		}
		result.Succeeded++
	}
	return result, nil
}

func (s *postgresAccountAdminService) BatchUpdate(ctx context.Context, providerID string, items []admin.AccountBatchPatch) (admin.BatchResult, error) {
	result := admin.BatchResult{Processed: len(items)}
	for _, item := range items {
		_, err := s.Update(ctx, providerID, item.AccountID, admin.AccountInput{Enabled: item.Enabled, Metadata: item.Metadata})
		if err != nil {
			result.Failed++
			result.Errors = append(result.Errors, item.AccountID+": "+err.Error())
			continue
		}
		result.Succeeded++
	}
	return result, nil
}

func (s *postgresAccountAdminService) Credential(context.Context, string) (string, error) {
	return "", errors.New("account credential access is not exposed by the admin runtime")
}

func (s *postgresAccountAdminService) RefreshQuota(context.Context, string) (admin.QuotaState, error) {
	return admin.QuotaState{}, errors.New("account quota refresh is unavailable: no provider quota contract")
}
func (s *postgresAccountAdminService) Quota(context.Context, string) (admin.QuotaState, error) {
	return admin.QuotaState{}, errors.New("account quota is unavailable: no provider quota contract")
}
func (s *postgresAccountAdminService) RevokeForProvider(ctx context.Context, providerID, accountID string) error {
	_, err := s.Update(ctx, providerID, accountID, admin.AccountInput{Enabled: new(false)})
	return err
}

func (s *postgresAccountAdminService) project(ctx context.Context, cfg *accounts.AccountConfig) contracts.Account {
	ref, _ := contracts.NewCredentialRef(cfg.CredentialRef.String())
	out := contracts.Account{ID: cfg.ID, Provider: cfg.ProviderID, CredentialRef: ref, Enabled: cfg.Enabled}
	if cfg.Labels != nil {
		out.Name = cfg.Labels["name"]
	}
	if s.records != nil {
		if record, err := s.records.Get(ctx, cfg.ID); err == nil {
			out.Email = record.Email
			out.ProviderAccountID = record.ProviderAccountID
			out.OrgID = record.OrgID
			out.OrgName = record.OrgName
			out.ReauthRequired = record.ReauthenticationRequired
		}
	}
	return out
}

var _ admin.AccountService = (*postgresAccountAdminService)(nil)
