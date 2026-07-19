import { BufferScriptError, fail } from '../errors.js';

function report(onWarning, message, error) {
  if (onWarning !== undefined) {
    onWarning(message, error);
  }
}

export function candidateHost(url) {
  try {
    return new URL(url).host;
  } catch (error) {
    throw new BufferScriptError('PLAYBACK_CDN_INVALID', 'CDN URL 无效', error);
  }
}

function request(url, fetchImpl, signal) {
  return fetchImpl(url, {
    method: 'GET',
    credentials: 'omit',
    cache: 'no-store',
    signal,
  });
}

function classifyResponse(response) {
  if (response.status === 401 || response.status === 403) {
    return 'SIGNATURE_EXPIRED';
  }
  if (response.status === 404) {
    return 'NOT_FOUND';
  }
  return 'TEMPORARY_HTTP_ERROR';
}

function abortError(message = '媒体请求被取消') {
  return new BufferScriptError('REQUEST_ABORTED', message);
}

function isExpectedAbort(error, signal) {
  return signal?.aborted === true || error?.name === 'AbortError' || error?.code === 'REQUEST_ABORTED';
}

function sleep(milliseconds, signal) {
  if (signal?.aborted === true) {
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function readCandidate(url, fetchImpl, signal, timeoutMilliseconds, readBody, nowMilliseconds) {
  const requestController = new AbortController();
  const forwardAbort = () => requestController.abort();
  if (signal?.aborted === true) {
    throw abortError();
  }
  signal?.addEventListener('abort', forwardAbort, { once: true });
  let timedOut = false;
  let timeoutReject;
  const timeout = setTimeout(() => {
    timedOut = true;
    requestController.abort();
    timeoutReject(new BufferScriptError('REQUEST_TIMEOUT', `媒体请求超时: ${candidateHost(url)}`));
  }, timeoutMilliseconds);
  const timeoutPromise = new Promise((_, reject) => {
    timeoutReject = reject;
  });
  try {
    const response = await Promise.race([
      request(url, fetchImpl, requestController.signal),
      timeoutPromise,
    ]);
    if (response.ok) {
      const body = await Promise.race([readBody(response), timeoutPromise]);
      const bytes = body?.bytes === undefined ? body : body.bytes;
      const byteLength = body?.byteLength === undefined ? bytes.byteLength : body.byteLength;
      return {
        kind: 'SUCCESS',
        value: { bytes, byteLength, url, completedAtMilliseconds: nowMilliseconds() },
        url,
      };
    }
    const kind = classifyResponse(response);
    return {
      kind,
      error: new BufferScriptError(kind, `媒体请求 ${response.status}: ${candidateHost(url)}`),
      url,
    };
  } catch (error) {
    if (signal?.aborted === true) {
      throw abortError();
    }
    if (timedOut) {
      throw new BufferScriptError('REQUEST_TIMEOUT', `媒体请求超时: ${candidateHost(url)}`, error);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', forwardAbort);
  }
}

function runCandidateRound(candidates, options, readBody) {
  const fetchImpl = options.fetchImpl || globalThis.fetch.bind(globalThis);
  const signal = options.signal;
  const timeoutMilliseconds = options.requestTimeoutMilliseconds;
  const roundController = new AbortController();
  const failures = [];
  let settled = false;
  let remaining = candidates.length;
  let onAbort;

  return new Promise((resolve, reject) => {
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      if (onAbort !== undefined) {
        signal?.removeEventListener('abort', onAbort);
      }
      resolve(result);
    };
    onAbort = () => {
      if (!settled) {
        settled = true;
        roundController.abort();
        reject(abortError());
      }
    };
    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    for (const url of candidates) {
      void readCandidate(
        url,
        fetchImpl,
        roundController.signal,
        timeoutMilliseconds,
        readBody,
        options.nowMilliseconds,
      )
        .then((result) => {
          if (settled) {
            return;
          }
          if (result.kind === 'SUCCESS') {
            settled = true;
            roundController.abort();
            signal?.removeEventListener('abort', onAbort);
            resolve(result);
            return;
          }
          failures.push(result);
          remaining -= 1;
          if (remaining === 0) {
            finish({ failures });
          }
        })
        .catch((error) => {
          if (settled && isExpectedAbort(error, roundController.signal)) {
            return;
          }
          if (signal?.aborted === true) {
            onAbort();
            return;
          }
          failures.push({ kind: 'TEMPORARY_NETWORK_ERROR', error, url });
          remaining -= 1;
          if (remaining === 0) {
            finish({ failures });
          }
        });
    }
  });
}

function nextBackoff(backoffMilliseconds, attempt) {
  if (!Array.isArray(backoffMilliseconds) || backoffMilliseconds.length === 0) {
    fail('RETRY_BACKOFF_MISSING', '媒体重试没有配置退避间隔');
  }
  return backoffMilliseconds[Math.min(attempt, backoffMilliseconds.length - 1)];
}

function allOfKind(failures, kind) {
  return failures.length > 0 && failures.every((failure) => failure.kind === kind);
}

function hasKind(failures, kind) {
  return failures.some((failure) => failure.kind === kind);
}

function validateOptions(options) {
  if (!Number.isFinite(options.requestTimeoutMilliseconds) || options.requestTimeoutMilliseconds <= 0) {
    fail('REQUEST_TIMEOUT_INVALID', '媒体请求超时必须为正数');
  }
  if (!Array.isArray(options.retryBackoffMilliseconds) || options.retryBackoffMilliseconds.length === 0) {
    fail('RETRY_BACKOFF_MISSING', '媒体重试没有配置退避间隔');
  }
}

async function fetchFromCandidates(candidates, options, readBody, kind) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    fail('PLAYBACK_CDN_MISSING', `没有可用于请求${kind}的 CDN 候选`);
  }
  const normalized = {
    ...options,
    requestTimeoutMilliseconds: options.requestTimeoutMilliseconds ?? 5000,
    retryBackoffMilliseconds: options.retryBackoffMilliseconds ?? [1000, 2000, 4000, 8000, 15000, 30000],
    nowMilliseconds: options.nowMilliseconds || (() => Date.now()),
  };
  validateOptions(normalized);
  let attempt = 0;
  while (true) {
    const result = await runCandidateRound(candidates, normalized, readBody);
    if (result.value !== undefined) {
      options.onSuccess?.({
        kind,
        ...result.value,
      });
      return result.value;
    }
    if (allOfKind(result.failures, 'NOT_FOUND')) {
      fail(
        kind === 'segment' ? 'SEGMENT_PERMANENT_404' : 'MANIFEST_PERMANENT_404',
        `必需${kind === 'segment' ? '媒体片段' : '清单'}在所有同清晰度 CDN 上均返回 404`,
        result.failures[result.failures.length - 1].error,
      );
    }
    if (hasKind(result.failures, 'SIGNATURE_EXPIRED')) {
      fail('SIGNATURE_EXPIRED', `${kind === 'segment' ? '媒体' : '清单'}候选出现 401/403，需要续期签名`);
    }
    for (const failure of result.failures) {
      report(
        normalized.onWarning,
        `${kind} 候选 ${candidateHost(failure.url)} 第 ${attempt + 1} 轮失败`,
        failure.error,
      );
    }
    normalized.onRetry?.({
      kind,
      attempt: attempt + 1,
      hosts: candidates.map((url) => candidateHost(url)),
    });
    await sleep(nextBackoff(normalized.retryBackoffMilliseconds, attempt), normalized.signal);
    attempt += 1;
  }
}

export async function fetchBytesFromCandidates(candidates, options = {}) {
  return fetchFromCandidates(
    candidates,
    options,
    async (response) => response.arrayBuffer(),
    'segment',
  );
}

export async function fetchTextFromCandidates(candidates, options = {}) {
  const result = await fetchFromCandidates(
    candidates,
    options,
    async (response) => {
      const bytes = await response.arrayBuffer();
      return { bytes: new TextDecoder().decode(bytes), byteLength: bytes.byteLength };
    },
    'manifest',
  );
  return {
    text: result.bytes,
    url: result.url,
    byteLength: result.byteLength,
    completedAtMilliseconds: result.completedAtMilliseconds,
  };
}
