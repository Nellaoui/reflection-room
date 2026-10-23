export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export function isUniqueConstraintError(error: unknown): boolean {
  const messages: string[] = [];
  let current = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    if (!(current instanceof Error)) break;
    messages.push(current.message);
    current = current.cause;
  }
  return /UNIQUE constraint failed/i.test(messages.join(" "));
}
