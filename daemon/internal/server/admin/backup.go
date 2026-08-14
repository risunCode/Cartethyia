package admin

import "net/http"
import "strings"

// RegisterBackup wires /v2/admin/backups/* routes.
func RegisterBackup(mux *http.ServeMux, services Services) {
	if services.Backup == nil {
		return
	}
	bkp := services.Backup

	mux.HandleFunc("/v2/admin/backups", requireMethods(map[string]http.HandlerFunc{
		http.MethodGet:  listBackups(bkp),
		http.MethodPost: createBackup(bkp),
	}))

	mux.HandleFunc("/v2/admin/backups/", func(w http.ResponseWriter, r *http.Request) {
		handleBackupSubresource(w, r, bkp)
	})
}

func handleBackupSubresource(w http.ResponseWriter, r *http.Request, svc BackupService) {
	rest := strings.TrimPrefix(r.URL.Path, "/v2/admin/backups/")
	parts := strings.Split(rest, "/")
	if len(parts) == 0 || parts[0] == "" {
		WriteError(w, NewError(CodeNotFound, "backup not found"))
		return
	}

	id := parts[0]
	tail := parts[1:]

	switch {
	case len(tail) == 0:
		switch r.Method {
		case http.MethodDelete:
			if err := svc.Delete(r.Context(), id); err != nil {
				WriteError(w, err)
				return
			}
			WriteStatus(w, http.StatusNoContent)
		case http.MethodGet:
			// GET on a single backup is not exposed directly; clients use /download.
			writeMethodNotAllowed(w, http.MethodDelete, http.MethodGet)
		default:
			writeMethodNotAllowed(w, http.MethodDelete, http.MethodGet)
		}
	case len(tail) == 1 && tail[0] == "download":
		if r.Method != http.MethodGet {
			writeMethodNotAllowed(w, http.MethodGet)
			return
		}
		artifact, err := svc.Download(r.Context(), id)
		if err != nil {
			WriteError(w, err)
			return
		}
		writeBackupArtifact(w, artifact)
	case len(tail) == 1 && tail[0] == "restore":
		if r.Method != http.MethodPost {
			writeMethodNotAllowed(w, http.MethodPost)
			return
		}
		var options RestoreOptions
		if err := decodeJSON(r, &options); err != nil {
			WriteError(w, NewError(CodeInvalidRequest, "invalid JSON body").WithCause(err))
			return
		}
		result, err := svc.Restore(r.Context(), id, options)
		if err != nil {
			WriteError(w, err)
			return
		}
		WriteData(w, http.StatusOK, result)
	default:
		WriteError(w, NewError(CodeNotFound, "backup subresource not found"))
	}
}

func writeBackupArtifact(w http.ResponseWriter, artifact BackupArtifact) {
	if artifact.MIMEType == "" {
		artifact.MIMEType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", artifact.MIMEType)
	if artifact.Filename != "" {
		w.Header().Set("Content-Disposition", "attachment; filename=\""+artifact.Filename+"\"")
	}
	w.WriteHeader(http.StatusOK)
	if len(artifact.Content) > 0 {
		_, _ = w.Write(artifact.Content)
	}
}

func listBackups(svc BackupService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		items, err := svc.List(r.Context())
		if err != nil {
			WriteError(w, err)
			return
		}
		WriteData(w, http.StatusOK, map[string]any{"items": items})
	}
}

func createBackup(svc BackupService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var input BackupCreateInput
		if err := decodeJSON(r, &input); err != nil {
			WriteError(w, NewError(CodeInvalidRequest, "invalid JSON body").WithCause(err))
			return
		}
		record, err := svc.Create(r.Context(), input)
		if err != nil {
			WriteError(w, err)
			return
		}
		WriteData(w, http.StatusCreated, record)
	}
}
