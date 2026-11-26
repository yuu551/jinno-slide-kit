// ローカルのブラウザ版でも、別サイトや DNS rebinding からの操作を受け付けない。
export function rejectForeignRequest(req, res) {
  const host = `127.0.0.1:${req.socket.localPort}`;
  const origin = req.headers.origin;
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const upload = req.url.split('?')[0] === '/api/upload';
  const invalid = req.headers.host !== host || (origin && origin !== `http://${host}`)
    || (req.method === 'POST' && !(upload ? type.startsWith('image/') || type === 'application/octet-stream' : type === 'application/json'));
  if (!invalid) return false;
  res.writeHead(403, { 'content-type': 'application/json', connection: 'close' });
  res.end(JSON.stringify({ error: 'このページからは操作できません' }));
  return true;
}
