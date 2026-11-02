/**
 * One structured log line per request. Only these keys are ever written: no
 * card text, cluster name, ref, prompt, model output, provider error message,
 * JWT, key, user id, or request body.
 */

export interface RequestLogLine {
  readonly function: string
  readonly run_id: string | null
  readonly cycle_id: string | null
  /** `ok` or the error code. */
  readonly code: string
  readonly http_status: number
  readonly duration_ms: number
  readonly provider_request_id: string | null
  readonly input_tokens: number | null
  readonly output_tokens: number | null
  readonly response_model: string | null
}

export type LogSink = (line: string) => void

/** Writes the line with exactly the listed keys, in a fixed order. */
export function writeRequestLog(sink: LogSink, line: RequestLogLine): void {
  sink(
    JSON.stringify({
      function: line.function,
      run_id: line.run_id,
      cycle_id: line.cycle_id,
      code: line.code,
      http_status: line.http_status,
      duration_ms: line.duration_ms,
      provider_request_id: line.provider_request_id,
      input_tokens: line.input_tokens,
      output_tokens: line.output_tokens,
      response_model: line.response_model,
    }),
  )
}
