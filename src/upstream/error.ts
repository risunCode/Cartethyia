/** Represents an upstream failure without exposing its body to clients. */
export class UpstreamError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string
  ) {
    super(message);
  }
}
