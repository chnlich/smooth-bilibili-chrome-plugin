export class BufferScriptError extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.name = 'BufferScriptError';
    this.code = code;
  }
}

export function fail(code, message, cause) {
  throw new BufferScriptError(code, message, cause);
}

export function toBufferScriptError(error, code, message) {
  if (error instanceof BufferScriptError) {
    return error;
  }
  return new BufferScriptError(code, message, error);
}

export function requireValue(value, code, message) {
  if (value === undefined || value === null) {
    fail(code, message);
  }
  return value;
}
