package api

import (
	"net/http"
	"strconv"
	"strings"

	consolecontracts "github.com/cartethyia/daemon/internal/console/contracts"
	"github.com/cartethyia/daemon/internal/router/batch"
)

const ConsoleBatchesPath = "/console/batches"

// RegisterBatches mounts the operator batch lifecycle. Routes remain mounted
// when the service is unavailable so an authorized operator receives a stable
// 503 rather than an ambiguous 404.
func RegisterBatches(mux *http.ServeMux, services Services) {
	mux.HandleFunc(ConsoleBatchesPath, requireMethods(map[string]http.HandlerFunc{
		http.MethodGet: func(w http.ResponseWriter, r *http.Request) {
			handleConsoleBatchList(w, r, services.Batch)
		},
		http.MethodPost: func(w http.ResponseWriter, r *http.Request) {
			handleConsoleBatchSubmit(w, r, services.Batch)
		},
	}))
	mux.HandleFunc(ConsoleBatchesPath+"/", func(w http.ResponseWriter, r *http.Request) {
		handleConsoleBatchItem(w, r, services.Batch)
	})
}

func handleConsoleBatchItem(w http.ResponseWriter, r *http.Request, service batch.Service) {
	tail := strings.TrimPrefix(r.URL.Path, ConsoleBatchesPath+"/")
	parts := strings.Split(strings.TrimSuffix(tail, "/"), "/")
	if len(parts) != 1 && len(parts) != 2 || parts[0] == "" {
		http.NotFound(w, r)
		return
	}
	switch {
	case len(parts) == 1 && r.Method == http.MethodGet:
		handleConsoleBatchGet(w, r, service, parts[0])
	case len(parts) == 2 && parts[1] == "cancel" && r.Method == http.MethodPost:
		handleConsoleBatchCancel(w, r, service, parts[0])
	case len(parts) == 2 && parts[1] == "progress" && r.Method == http.MethodGet:
		handleConsoleBatchProgress(w, r, service, parts[0])
	case len(parts) == 1:
		writeMethodNotAllowed(w, http.MethodGet)
	case len(parts) == 2 && parts[1] == "cancel":
		writeMethodNotAllowed(w, http.MethodPost)
	case len(parts) == 2 && parts[1] == "progress":
		writeMethodNotAllowed(w, http.MethodGet)
	default:
		http.NotFound(w, r)
	}
}

func handleConsoleBatchSubmit(w http.ResponseWriter, r *http.Request, service batch.Service) {
	if service == nil {
		WriteError(w, NewError(CodeAdminUnavailable, "batch service is unavailable"))
		return
	}
	var input consolecontracts.BatchSubmitRequest
	if err := decodeJSON(r, &input); err != nil {
		WriteError(w, NewError(CodeInvalidRequest, "invalid batch body").WithCause(err))
		return
	}
	if err := input.Key.Validate(); err != nil {
		WriteError(w, NewError(CodeInvalidRequest, err.Error()))
		return
	}
	if len(input.Items) == 0 {
		WriteError(w, NewError(CodeInvalidRequest, "batch items are required"))
		return
	}
	job, err := service.Submit(r.Context(), batch.Group{Key: input.Key, Items: input.Items})
	if err != nil {
		WriteError(w, err)
		return
	}
	WriteDataRequest(w, r, http.StatusAccepted, projectConsoleBatchJob(job))
}

func handleConsoleBatchList(w http.ResponseWriter, r *http.Request, service batch.Service) {
	if service == nil {
		WriteError(w, NewError(CodeAdminUnavailable, "batch service is unavailable"))
		return
	}
	limit, err := consoleBatchLimit(r)
	if err != nil {
		WriteError(w, NewError(CodeInvalidRequest, "invalid batch limit").WithCause(err))
		return
	}
	state := batch.State(strings.TrimSpace(r.URL.Query().Get("state")))
	if state != "" && !validConsoleBatchState(state) {
		WriteError(w, NewError(CodeInvalidRequest, "invalid batch state"))
		return
	}
	jobs, err := service.List(r.Context(), state, limit)
	if err != nil {
		WriteError(w, err)
		return
	}
	data := make([]consolecontracts.BatchJob, 0, len(jobs))
	for _, job := range jobs {
		data = append(data, projectConsoleBatchJob(job))
	}
	WriteDataRequest(w, r, http.StatusOK, consolecontracts.BatchListResponse{Object: "list", Data: data})
}

func handleConsoleBatchGet(w http.ResponseWriter, r *http.Request, service batch.Service, id string) {
	if service == nil {
		WriteError(w, NewError(CodeAdminUnavailable, "batch service is unavailable"))
		return
	}
	job, items, err := service.Get(r.Context(), id)
	if err != nil {
		WriteError(w, err)
		return
	}
	projected := make([]consolecontracts.BatchItem, 0, len(items))
	for _, item := range items {
		projected = append(projected, projectConsoleBatchItem(item))
	}
	WriteDataRequest(w, r, http.StatusOK, consolecontracts.BatchGetResponse{
		Job: projectConsoleBatchJob(job), Items: projected,
	})
}

func handleConsoleBatchCancel(w http.ResponseWriter, r *http.Request, service batch.Service, id string) {
	if service == nil {
		WriteError(w, NewError(CodeAdminUnavailable, "batch service is unavailable"))
		return
	}
	job, err := service.Cancel(r.Context(), id)
	if err != nil {
		WriteError(w, err)
		return
	}
	WriteDataRequest(w, r, http.StatusOK, projectConsoleBatchJob(job))
}

func handleConsoleBatchProgress(w http.ResponseWriter, r *http.Request, service batch.Service, id string) {
	if service == nil {
		WriteError(w, NewError(CodeAdminUnavailable, "batch service is unavailable"))
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
	WriteDataRequest(w, r, http.StatusOK, consolecontracts.BatchProgress{
		JobID: progress.Job.ID, State: state, Total: progress.Total,
		Completed: progress.Completed, Failed: progress.Failed,
		Pending:   progress.Queued + progress.Running,
		UpdatedAt: progress.UpdatedAt,
	})
}

func consoleBatchLimit(r *http.Request) (int, error) {
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

func validConsoleBatchState(state batch.State) bool {
	switch state {
	case batch.StateQueued, batch.StateRunning, batch.StateCompleted,
		batch.StateFailed, batch.StateCancelled, batch.StateExpired:
		return true
	default:
		return false
	}
}

func projectConsoleBatchJob(job batch.Job) consolecontracts.BatchJob {
	return consolecontracts.BatchJob{
		ID: job.ID, State: job.State, CreatedAt: job.CreatedAt,
		ExpiresAt: job.ExpiresAt, ItemCount: job.ItemCount,
	}
}

func projectConsoleBatchItem(item batch.Item) consolecontracts.BatchItem {
	return consolecontracts.BatchItem{
		ID: item.ID, JobID: item.JobID, Position: item.Position,
		RequestID: item.RequestID, State: item.State,
	}
}
