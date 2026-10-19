export class AppError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export function safeError(error: unknown): { code: string; message: string } {
  if (error instanceof AppError) return { code: error.code, message: error.message };
  // Do not serialize raw Playwright errors: they can include URLs, form values, or HTML.
  return { code: 'OPERATION_FAILED', message: 'The operation could not finish. Check diagnostics and the live action log before deciding what to do next.' };
}
