export class BankFallbackError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'BankFallbackError';
    this.code = 'BANK_FALLBACK';
  }
}

export class BankNetworkError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'BankNetworkError';
    this.code = 'BANK_NETWORK_FAILED';
  }
}
