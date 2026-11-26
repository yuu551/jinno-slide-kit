import { readFileSync } from 'node:fs';

export const uvInstallHint = 'uv が必要です。brew install uv でインストールしてください。';

// キットの外に作った資料にも、キットで検証した Python を使う。
export function uvScriptArgs(script, ...args) {
  const version = readFileSync(new URL('../../.python-version', import.meta.url), 'utf8').trim();
  return ['run', '--managed-python', '--python', version, script, ...args];
}
