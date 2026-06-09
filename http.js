export const sleep = ms => new Promise(r => setTimeout(r, ms));

const RETRY_AFTER_CAP_MS = 60000;

export function parseRetryAfter(value, capMs = RETRY_AFTER_CAP_MS) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.min(Math.max(0, seconds * 1000), capMs);
  }
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.min(Math.max(0, at - Date.now()), capMs) : null;
}

export function isRetriableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

export async function fetchWithTimeout(url, opts, { timeoutMs, service }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = new Error(`истёк таймаут запроса к ${service}`);
      err.isTimeout = true;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function drainResponse(resp) {
  try {
    await resp.text();
  } catch {
    try { await resp.body?.cancel?.(); } catch {}
  }
}

export async function withRetry(fn, { attempts = 3, baseMs = 1000, retryStatuses = true } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await fn();
      if (!retryStatuses || !isRetriableStatus(resp.status) || i === attempts - 1) return resp;
      const retryAfter = parseRetryAfter(resp.headers?.get?.('retry-after'));
      await drainResponse(resp);
      await sleep(retryAfter ?? baseMs * 2 ** i);
    } catch (e) {
      if (e.isAuthError || e.isTimeout || i === attempts - 1) throw e;
      lastErr = e;
      await sleep(baseMs * 2 ** i);
    }
  }
  throw lastErr;
}
