// Thin fetch wrapper. Every response is normalised to { ok, status, data, error }
// so views never deal with raw responses. Network failures become a friendly
// message rather than an unhandled rejection.

async function request(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch (err) {
    return { ok: false, status: 0, data: null, error: "Can't reach the app server. Is it running?" };
  }

  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (err) {
      data = null;
    }
  }

  if (!res.ok) {
    const error = (data && data.error) || 'Something went wrong. Please try again.';
    return { ok: false, status: res.status, data, error, code: data && data.code };
  }
  return { ok: true, status: res.status, data, error: null };
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body) => request('POST', url, body),
  put: (url, body) => request('PUT', url, body),
  del: (url, body) => request('DELETE', url, body),
};
