export interface WebhookResponse {
  success: boolean;
  message: string;
  data?: unknown;
}

export interface ServiceResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}
