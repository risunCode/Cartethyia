// Error classes for DevinRouter

export class PoolExhaustedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PoolExhaustedError";
	}
}

export class DevinAuthError extends Error {
	readonly statusCode: number;

	constructor(message: string, statusCode: number) {
		super(message);
		this.name = "DevinAuthError";
		this.statusCode = statusCode;
	}
}

export class DevinApiError extends Error {
	readonly statusCode: number;

	constructor(message: string, statusCode: number) {
		super(message);
		this.name = "DevinApiError";
		this.statusCode = statusCode;
	}
}

/** A definitive account-level quota exhaustion; safe to remove from the active pool. */
export class DevinQuotaError extends DevinApiError {
	constructor(message: string, statusCode = 429) {
		super(message, statusCode);
		this.name = "DevinQuotaError";
	}
}

/** A temporary per-account limit; retry another account without disabling this one. */
export class DevinAccountLimitError extends DevinApiError {
	constructor(message: string, statusCode = 429) {
		super(message, statusCode);
		this.name = "DevinAccountLimitError";
	}
}

/**
 * Returns true only for an explicit account quota exhaustion signal.
 * Generic 429s and resource/capacity errors remain retryable upstream errors.
 */
export function isDefinitiveQuotaError(error: unknown): error is DevinQuotaError {
	return error instanceof DevinQuotaError;
}

/** Detect a temporary per-account message/rate limit that should rotate but not disable. */
export function hasTemporaryAccountLimitMessage(message: string): boolean {
	return /\b(?:message|account) rate limit\b|\brate limit\b[\s\S]{0,80}\b(?:this model|resets? in|try again later)\b/i.test(
		message,
	);
}

/** Detect explicit account-quota wording without classifying temporary rate limits as exhausted. */
export function hasDefinitiveQuotaMessage(message: string): boolean {
	return /\b(?:quota|usage limit|credits?)\b[\s\S]{0,80}\b(?:exhausted|exceeded|depleted|reached)\b|\b(?:exhausted|exceeded|depleted|reached)\b[\s\S]{0,80}\b(?:quota|usage limit|credits?)\b/i.test(
		message,
	);
}

export class ConfigError extends Error {
	readonly path: string;

	constructor(message: string, path: string) {
		super(message);
		this.name = "ConfigError";
		this.path = path;
	}
}
