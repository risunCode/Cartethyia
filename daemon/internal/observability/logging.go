// Logging primitives for the daemon observability package.
//
// The Logger interface is vendor-neutral: handlers, proxy code, and runtime
// wiring consume it without depending on any SDK. The default implementation
// is backed by log/slog; callers may substitute any other Logger via
// Registry.WithLogger.
//
// Sensitive fields are redacted by default. Keys matching the
// defaultSensitiveKeys set (case-insensitive) and any field with Redact=true
// are replaced with RedactedValue in output. Use WithoutRedaction to opt out
// during local debugging; the explicit Redact flag is honoured even then.
package observability

import (
	"context"
	"io"
	"log/slog"
	"os"
	"strings"
	"time"
)

// Level is the severity of a log record.
type Level int

const (
	LevelDebug Level = iota
	LevelInfo
	LevelWarn
	LevelError
)

// String returns the canonical lowercase name of the level.
func (l Level) String() string {
	switch l {
	case LevelDebug:
		return "debug"
	case LevelInfo:
		return "info"
	case LevelWarn:
		return "warn"
	case LevelError:
		return "error"
	default:
		return "info"
	}
}

func (l Level) slogLevel() slog.Level {
	switch l {
	case LevelDebug:
		return slog.LevelDebug
	case LevelInfo:
		return slog.LevelInfo
	case LevelWarn:
		return slog.LevelWarn
	case LevelError:
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

// Field is a single structured log attribute. Use the typed constructors so
// values render consistently across handlers.
type Field struct {
	Key   string
	Value any
	// Redact forces the output to be replaced with RedactedValue regardless
	// of the field key. The default logger also redacts keys in the default
	// sensitive set; this flag extends the rule to user-defined keys.
	Redact bool
}

// String formats a string value.
func String(key, value string) Field { return Field{Key: key, Value: value} }

// Int formats an int value.
func Int(key string, value int) Field { return Field{Key: key, Value: value} }

// Int64 formats an int64 value.
func Int64(key string, value int64) Field { return Field{Key: key, Value: value} }

// Float64 formats a float64 value.
func Float64(key string, value float64) Field { return Field{Key: key, Value: value} }

// Bool formats a bool value.
func Bool(key string, value bool) Field { return Field{Key: key, Value: value} }

// Duration formats a duration in slog's default representation.
func Duration(key string, value time.Duration) Field { return Field{Key: key, Value: value} }

// Time formats a time in slog's default representation.
func Time(key string, value time.Time) Field { return Field{Key: key, Value: value} }

// Any formats an arbitrary value using the underlying handler's rules.
func Any(key string, value any) Field { return Field{Key: key, Value: value} }

// Redacted marks the value as sensitive. The default Logger replaces it with
// RedactedValue; the explicit flag is honoured even when WithoutRedaction is
// in effect, so a careless opt-out cannot leak values tagged as redacted.
func Redacted(key, value string) Field { return Field{Key: key, Value: value, Redact: true} }

// Error formats an error as a sensitive field. Error strings frequently wrap
// provider responses or transport details, so they are redacted by default
// just like credentials. A nil error produces a field with Value=nil; the
// default Logger drops nil-valued fields, so callers can pass the result of
// Error(err) unconditionally.
func Error(err error) Field {
	if err == nil {
		return Field{Key: "error", Value: nil}
	}
	return Field{Key: "error", Value: err, Redact: true}
}

// Logger emits structured records correlated with the request context.
type Logger interface {
	// With returns a new logger that prefixes every record with the given
	// fields. The receiver is not modified; chained With calls accumulate.
	With(fields ...Field) Logger
	// Debug records a debug-level message.
	Debug(ctx context.Context, msg string, fields ...Field)
	// Info records an info-level message.
	Info(ctx context.Context, msg string, fields ...Field)
	// Warn records a warn-level message.
	Warn(ctx context.Context, msg string, fields ...Field)
	// Error records an error-level message.
	Error(ctx context.Context, msg string, fields ...Field)
	// Log records a message at an explicit level.
	Log(ctx context.Context, level Level, msg string, fields ...Field)
	// WithoutRedaction returns a logger that emits values for sensitive keys
	// verbatim. Use only for local debugging in trusted environments; the
	// explicit Field.Redact flag is still honoured.
	WithoutRedaction() Logger
}

// RedactedValue is the literal written to output in place of a redacted value.
const RedactedValue = "[REDACTED]"

// defaultSensitiveKeys is the case-insensitive set of field keys whose values
// are always replaced with RedactedValue in output. Headers that carry
// credentials and common token names are covered. Add new entries via package
// edits rather than runtime configuration so the safety net is immutable.
var defaultSensitiveKeys = map[string]struct{}{
	"authorization":       {},
	"proxy-authorization": {},
	"cookie":              {},
	"set-cookie":          {},
	"token":               {},
	"access_token":        {},
	"refresh_token":       {},
	"id_token":            {},
	"bearer":              {},
	"x-api-key":           {},
	"api-key":             {},
	"apikey":              {},
	"password":            {},
	"passwd":              {},
	"secret":              {},
	"client_secret":       {},
	"credential":          {},
	"credentials":         {},
	"private_key":         {},
	"private-key":         {},
}

// IsSensitiveKey reports whether the key is in the default sensitive set.
func IsSensitiveKey(key string) bool {
	_, found := defaultSensitiveKeys[strings.ToLower(strings.TrimSpace(key))]
	return found
}

// stdlibLogger is the default Logger, backed by log/slog.
type stdlibLogger struct {
	handler  *slog.Logger
	base     []Field
	redacted bool
}

// NewLogger returns a JSON Logger that writes to w (os.Stderr if w is nil) at
// the given level. Sensitive keys are redacted by default.
func NewLogger(w io.Writer, level Level) Logger {
	if w == nil {
		w = os.Stderr
	}
	h := slog.NewJSONHandler(w, &slog.HandlerOptions{Level: level.slogLevel()})
	return &stdlibLogger{handler: slog.New(h), redacted: true}
}

// NewTextLogger returns a text-format Logger (for human-readable dev output).
func NewTextLogger(w io.Writer, level Level) Logger {
	if w == nil {
		w = os.Stderr
	}
	h := slog.NewTextHandler(w, &slog.HandlerOptions{Level: level.slogLevel()})
	return &stdlibLogger{handler: slog.New(h), redacted: true}
}

func (l *stdlibLogger) With(fields ...Field) Logger {
	merged := make([]Field, 0, len(l.base)+len(fields))
	merged = append(merged, l.base...)
	merged = append(merged, fields...)
	return &stdlibLogger{handler: l.handler, base: merged, redacted: l.redacted}
}

func (l *stdlibLogger) Debug(ctx context.Context, msg string, fields ...Field) {
	l.Log(ctx, LevelDebug, msg, fields...)
}

func (l *stdlibLogger) Info(ctx context.Context, msg string, fields ...Field) {
	l.Log(ctx, LevelInfo, msg, fields...)
}

func (l *stdlibLogger) Warn(ctx context.Context, msg string, fields ...Field) {
	l.Log(ctx, LevelWarn, msg, fields...)
}

func (l *stdlibLogger) Error(ctx context.Context, msg string, fields ...Field) {
	l.Log(ctx, LevelError, msg, fields...)
}

func (l *stdlibLogger) Log(ctx context.Context, level Level, msg string, fields ...Field) {
	attrs := make([]slog.Attr, 0, len(l.base)+len(fields))
	attrs = append(attrs, l.toAttrs(l.base)...)
	attrs = append(attrs, l.toAttrs(fields)...)
	l.handler.LogAttrs(ctx, level.slogLevel(), msg, attrs...)
}

func (l *stdlibLogger) WithoutRedaction() Logger {
	return &stdlibLogger{handler: l.handler, base: l.base, redacted: false}
}

func (l *stdlibLogger) toAttrs(fields []Field) []slog.Attr {
	out := make([]slog.Attr, 0, len(fields))
	for _, f := range fields {
		if f.Key == "" {
			continue
		}
		if f.Value == nil && !f.Redact {
			continue
		}
		if l.shouldRedact(f) {
			out = append(out, slog.String(f.Key, RedactedValue))
			continue
		}
		out = append(out, slog.Any(f.Key, f.Value))
	}
	return out
}

func (l *stdlibLogger) shouldRedact(f Field) bool {
	if f.Redact {
		return true
	}
	if !l.redacted {
		return false
	}
	return IsSensitiveKey(f.Key)
}

// nopLogger is a Logger that drops every record.
type nopLogger struct{}

// NopLogger returns a Logger that discards every record. It is the default
// logger held by a freshly constructed Registry.
func NopLogger() Logger { return nopLogger{} }

func (nopLogger) With(...Field) Logger { return nopLogger{} }
func (nopLogger) Debug(context.Context, string, ...Field) {
}
func (nopLogger) Info(context.Context, string, ...Field)  {}
func (nopLogger) Warn(context.Context, string, ...Field)  {}
func (nopLogger) Error(context.Context, string, ...Field) {}
func (nopLogger) Log(context.Context, Level, string, ...Field) {
}
func (nopLogger) WithoutRedaction() Logger { return nopLogger{} }

// LogError emits an error-level record that includes err in the "error" field.
// It is a convenience for the common "log and propagate the error" path.
func LogError(log Logger, ctx context.Context, msg string, err error, fields ...Field) {
	if log == nil {
		return
	}
	all := make([]Field, 0, len(fields)+1)
	all = append(all, fields...)
	all = append(all, Error(err))
	log.Error(ctx, msg, all...)
}
