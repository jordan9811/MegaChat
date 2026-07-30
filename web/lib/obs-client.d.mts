export const OBS_ERRORS: {
  UNSUPPORTED: 'UNSUPPORTED'
  NOT_REACHABLE: 'NOT_REACHABLE'
  AUTH_FAILED: 'AUTH_FAILED'
  HANDSHAKE_FAILED: 'HANDSHAKE_FAILED'
  REQUEST_FAILED: 'REQUEST_FAILED'
  DISCONNECTED: 'DISCONNECTED'
}

export class ObsError extends Error {
  kind: keyof typeof OBS_ERRORS
  closeCode?: number
  requestType?: string
  code?: number
  comment?: string
}

export function computeAuth(password: string, salt: string, challenge: string): Promise<string>

export class ObsClient {
  constructor(opts?: { url?: string; password?: string })
  url: string
  password: string
  rpcVersion: number | null
  connect(opts?: { timeoutMs?: number }): Promise<this>
  request<T = Record<string, unknown>>(
    requestType: string,
    requestData?: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<T>
  close(): void
}

export default ObsClient
