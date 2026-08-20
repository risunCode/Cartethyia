package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/cartethyia/daemon/internal/router/batch"
	apicontracts "github.com/cartethyia/daemon/internal/gateway/contracts"
)

const (
	BatchesPath = "/v1/batches"
)

func registerBatch(mux *http.ServeMux, deps Deps) {
	mux.HandleFunc(BatchesPath, func(w http.ResponseWriter, r *http.Request) {
		handleBatchCollection(w, r, deps.Batch)
	})
	mux.HandleFunc(BatchesPath+"/", func(w http.ResponseWriter, r *http.Request) {
		handleBatchItem(w, r, deps.Batch)
	})
}

func handleBatchCollection(w http.ResponseWriter, r *http.Request, service batch.Service) {
	switch r.Method {
	case http.MethodGet:
		handleBatchList(w, r, service)
	case http.MethodPost:
		handleBatchSubmit(w, r, service)
	default:
		MethodNotAllowed(w, http.MethodGet+", "+http.MethodPost)
	}
}

func handleBatchItem(w http.ResponseWriter, r *http.Request, service batch.Service) {
	tail := strings.TrimPrefix(r.URL.Path, BatchesPath+"/")
	parts := strings.Split(strings.TrimSuffix(tail, "/"), "/")
	if len(parts) != 2 && len(parts) != 1 {
		NotFound(w, "batch route not found")
		return
	}
	if parts[0] == "" || strings.Contains(parts[0], "/") {
		NotFound(w, "batch route not found")
		return
	}
	switch {
	case len(parts) == 1 && r.Method == http.MethodGet:
		handleBatchGet(w, r, service, parts[0])
	case len(parts) == 2 && parts[1] == "cancel" && r.Method == http.MethodPost:
		handleBatchCancel(w, r, service, parts[0])
	case len(parts) == 2 && parts[1] == "progress" && r.Method == http.MethodGet:
		handleBatchProgress(w, r, service, parts[0])
	case len(parts) == 1:
		MethodNotAllowed(w, http.MethodGet)
	case len(parts) == 2 && parts[1] == "cancel":
		MethodNotAllowed(w, http.MethodPost)
	case len(parts) == 2 && parts[1] == "progress":
		MethodNotAllowed(w, http.MethodGet)
	default:
		NotFound(w, "batch route not found")
	}
}

func handleBatchSubmit(w http.ResponseWriter, r *http.Request, service batch.Service) {
	if service == nil {
		Write(w, http.StatusServiceUnavailable, CodeInternal, "batch service is not configured")
		return
	}
	if !HasJSONContentType(r) {
		Write(w, http.StatusUnsupportedMediaType, CodeUnsupportedMedia, "content type must be application/json")
		return
	}
	body, err := ReadBoundedJSON(r, MaxBodyBytes)
	if err != nil {
		WriteError(w, err)
		return
	}
	var input apicontracts.BatchSubmitRequest
	if err := json.Unmarshal(body, &input); err != nil {
		Write(w, http.StatusBadRequest, CodeInvalidRequest, "invalid batch body")
		return
	}
	if err := input.Key.Validate(); err != nil {
		Write(w, http.StatusBadRequest, CodeInvalidRequest, err.Error())
		return
	}
	if len(input.Items) == 0 {
		Write(w, http.StatusBadRequest, CodeInvalidRequest, "batch items are required")
		return
	}
	job, err := service.Submit(r.Context(), batch.Group{Key: input.Key, Items: input.Items})
	if err != nil {
		WriteError(w, err)
		return
	}
	writeBatchJSON(w, http.StatusAccepted, projectBatchJob(job))
}

func handleBatchList(w http.ResponseWriter, r *http.Request, service batch.Service) {
	if service == nil {
		Write(w, http.StatusServiceUnavailable, CodeInternal, "batch service is not configured")
		return
	}
	limit, err := batchLimit(r)
	if err != nil {
		Write(w, http.StatusBadRequest, CodeInvalidRequest, err.Error())
		return
	}
	state := batch.State(strings.TrimSpace(r.URL.Query().Get("state")))
	if state != "" && !validBatchState(state) {
		Write(w, http.StatusBadRequest, CodeInvalidRequest, "invalid batch state")
		return
	}
	jobs, err := service.List(r.Context(), state, limit)
	if err != nil {
		WriteError(w, err)
		return
	}
	data := make([]apicontracts.BatchJob, 0, len(jobs))
	for _, job := range jobs {
		data = append(data, projectBatchJob(job))
	}
	writeBatchJSON(w, http.StatusOK, apicontracts.BatchListResponse{Object: "list", Data: data})
}

func handleBatchGet(w http.ResponseWriter, r *http.Request, service batch.Service, id string) {
	if service == nil {
		Write(w, http.StatusServiceUnavailable, CodeInternal, "batch service is not configured")
		return
	}
	job, items, err := service.Get(r.Context(), id)
	if err != nil {
		WriteError(w, err)
		return
	}
	projected := make([]apicontracts.BatchItem, 0, len(items))
	for _, item := range items {
		projected = append(projected, projectBatchItem(item))
	}
	writeBatchJSON(w, http.StatusOK, apicontracts.BatchGetResponse{Job: projectBatchJob(job), Items: projected})
}

func handleBatchCancel(w http.ResponseWriter, r *http.Request, service batch.Service, id string) {
	if service == nil {
		Write(w, http.StatusServiceUnavailable, CodeInternal, "batch service is not configured")
		return
	}
	job, err := service.Cancel(r.Context(), id)
	if err != nil {
		WriteError(w, err)
		return
	}
	writeBatchJSON(w, http.StatusOK, projectBatchJob(job))
}

func handleBatchProgress(w http.ResponseWriter, r *http.Request, service batch.Service, id string) {
	if service == nil {
		Write(w, http.StatusServiceUnavailable, CodeInternal, "batch service is not configured")
		return
	}
	progress, err := service.Progress(r.Context(), id)
	if err != nil {
		WriteError(w, err)
		return
	}
	state := progress.State
	if state == "" {
		state = progress.Job.State
	}
	writeBatchJSON(w, http.StatusOK, apicontracts.BatchProgress{
		JobID: progress.Job.ID, State: state, Total: progress.Total,
		Completed: progress.Completed, Failed: progress.Failed,
		Pending: progress.Queued + progress.Running,
		UpdatedAt: progress.UpdatedAt,
	})
}

func batchLimit(r *http.Request) (int, error) {
	raw := strings.TrimSpace(r.URL.Query().Get("limit"))
	if raw == "" {
		return 100, nil
	}
	limit, err := strconv.Atoi(raw)
	if err != nil || limit < 1 {
		return 0, strconv.ErrSyntax
	}
	if limit > 1000 {
		limit = 1000
	}
	return limit, nil
}

func validBatchState(state batch.State) bool {
	switch state {
	case batch.StateQueued, batch.StateRunning, batch.StateCompleted,
		batch.StateFailed, batch.StateCancelled, batch.StateExpired:
		return true
	default:
		return false
	}
}

func projectBatchJob(job batch.Job) apicontracts.BatchJob {
	return apicontracts.BatchJob{
		ID: job.ID, State: job.State, CreatedAt: job.CreatedAt,
		ExpiresAt: job.ExpiresAt, ItemCount: job.ItemCount,
	}
}

func projectBatchItem(item batch.Item) apicontracts.BatchItem {
	return apicontracts.BatchItem{
		ID: item.ID, JobID: item.JobID, Position: item.Position,
		RequestID: item.RequestID, State: item.State,
	}
}

func writeBatchJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
