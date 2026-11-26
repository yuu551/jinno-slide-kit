import fs from 'node:fs';
import path from 'node:path';
function resolved(p) {
  try { return fs.realpathSync(p); } catch {
    try { fs.lstatSync(p); return null; } catch {}
    const parent = path.dirname(p);
    if (parent === p) return null;
    const real = resolved(parent);
    return real && path.join(real, path.basename(p));
  }
}
export function inside(base, rel) {
  const root = path.resolve(base), file = path.resolve(base, rel);
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  const realRoot = resolved(root), realFile = resolved(file);
  return realRoot && realFile && (realFile === realRoot || realFile.startsWith(realRoot + path.sep)) ? file : null;
}
