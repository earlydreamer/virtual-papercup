import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from 'vite';
import config from '../vite.config.ts';

function isolateEnv(t, values) {
  const keys = ['PCUP_HOST', 'PCUP_PLAIN', 'PCUP_ALLOWED_HOSTS'];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const key of keys) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
}

test('기본 서버는 로컬 바인딩이며 공개 폴더 복사·소스맵을 끈다', (t) => {
  isolateEnv(t, {PCUP_HOST: '', PCUP_PLAIN: '', PCUP_ALLOWED_HOSTS: ''});
  const actual = config({ mode: 'test', command: 'serve' });
  assert.equal(actual.server.host, 'localhost');
  assert.equal(actual.preview.host, 'localhost');
  assert.equal(actual.server.fs.strict, true);
  assert.equal(actual.publicDir, false);
  assert.equal(actual.build.sourcemap, false);
  assert.equal(actual.plugins.length, 1);
});

test('PCUP 파일 설정과 환경 변수 우선순위를 적용한다', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'papercup-env-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, '.env.local'), 'PCUP_HOST=localhost\nPCUP_PLAIN=1\nPCUP_ALLOWED_HOSTS=example.com\n');
  isolateEnv(t, {});
  const env = loadEnv('test', dir, 'PCUP_');
  Object.assign(process.env, env);
  const actual = config({ mode: 'test', command: 'serve' });
  assert.equal(actual.plugins.length, 0);
  assert.deepEqual(actual.server.allowedHosts, ['example.com']);
  assert.deepEqual(actual.preview.allowedHosts, ['example.com']);
});

test('허용 호스트에 와일드카드·URL·전체 하위 도메인 지정을 거부한다', (t) => {
  const original = process.env.PCUP_ALLOWED_HOSTS;
  t.after(() => {
    if (original === undefined) delete process.env.PCUP_ALLOWED_HOSTS;
    else process.env.PCUP_ALLOWED_HOSTS = original;
  });
  for (const invalid of ['*', '.example.com', 'https://example.com']) {
    process.env.PCUP_ALLOWED_HOSTS = invalid;
    assert.throws(() => config({ mode: 'test', command: 'serve' }), /정확한 호스트/);
  }
});
