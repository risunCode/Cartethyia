package runtime

import (
	"context"
	"fmt"

	"github.com/cartethyia/daemon/internal/database/models"
	dbrepositories "github.com/cartethyia/daemon/internal/database/repositories"
	"github.com/cartethyia/daemon/internal/proxy/runtime"
	"github.com/cartethyia/daemon/internal/proxy/protocol/contracts"
)

type compositeAccountStore struct {
	primary          proxy.AccountStore
	custom           map[string][]proxy.Account
	customRepository dbrepositories.CustomProviderRepository
}

func (s compositeAccountStore) ListAccounts(ctx context.Context, providerID string) ([]proxy.Account, error) {
	var result []proxy.Account
	if s.primary != nil {
		accounts, err := s.primary.ListAccounts(ctx, providerID)
		if err != nil {
			return nil, err
		}
		result = append(result, accounts...)
	}
	if s.customRepository != nil {
		rows, err := s.customRepository.ListCustomProviders(ctx)
		if err != nil {
			return nil, err
		}
		custom, err := buildCustomProviderAccounts(rows)
		if err != nil {
			return nil, err
		}
		for _, account := range custom[providerID] {
			result = append(result, account)
		}
	}
	for _, account := range s.custom[providerID] {
		result = append(result, account)
	}
	return result, nil
}

func buildCustomProviderAccounts(rows []models.CustomProvider) (map[string][]proxy.Account, error) {
	result := make(map[string][]proxy.Account)
	for _, row := range rows {
		refs := row.CredentialRefs
		if len(refs) == 0 && row.CredentialRef != "" {
			refs = []string{row.CredentialRef}
		}
		for index, ref := range refs {
			credentialRef, err := contracts.NewCredentialRef(ref)
			if err != nil {
				return nil, fmt.Errorf("custom provider %q credential reference %d: %w", row.Slug, index, err)
			}
			result[row.Slug] = append(result[row.Slug], proxy.Account{
				ID: fmt.Sprintf("custom:%s:%d", row.Slug, index), Provider: row.Slug,
				CredentialRef: credentialRef, Enabled: true,
			})
		}
	}
	return result, nil
}
