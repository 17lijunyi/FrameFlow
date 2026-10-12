const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function createExecutorRouter({store, readJsonBody, sendJson}) {
  return async function routeExecutors(request, response, url) {
    if (!['/api/executors', '/api/executors/scan', '/api/executors/selection'].includes(url.pathname)) return false;
    const origin = request.headers.origin;
    if (!LOCAL_HOSTS.has(url.hostname) || (origin && origin !== url.origin) || request.headers['sec-fetch-site'] === 'cross-site') {
      throw Object.assign(new Error('执行者设置仅允许来自 FrameFlow 本地页面'), {statusCode: 403});
    }
    response.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/api/executors' && request.method === 'GET') {
      sendJson(response, 200, await store.read());
    } else if (['/api/executors', '/api/executors/selection'].includes(url.pathname) && request.method === 'PUT') {
      if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) {
        throw Object.assign(new Error('请求内容必须为 JSON'), {statusCode: 415});
      }
      const input = await readJsonBody(request);
      sendJson(response, 200, await (url.pathname.endsWith('/selection') ? store.saveSelection(input) : store.save(input)));
    } else if (url.pathname === '/api/executors/scan' && request.method === 'POST') {
      sendJson(response, 200, await store.scan());
    } else sendJson(response, 405, {error: '不支持的执行者设置操作'});
    return true;
  };
}
