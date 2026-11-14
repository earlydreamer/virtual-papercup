import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentIssues, pathIssues, scanRepository } from '../scripts/check-repo.mjs';

// 실제 주소·인증 정보를 fixture로 복사하지 않습니다.
const privateAddress = [192, 168, 42, 7].join('.');
const token = ['ghp', 'a'.repeat(36)].join('_');
const bytes = (text) => Buffer.from(text);

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'papercup-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });
  git('init', '-q');
  const put = (name, text) => {
    const parts = name.split('/');
    mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true });
    writeFileSync(join(root, name), text);
  };
  return { root, git, put };
}

test('공개 문서·기본 예시와 저장소 자체 검사가 통과한다', (t) => {
  const { root, put } = fixture(t);
  put('README.md', '공개 문서 https://example.com 및 .env.local 안내');
  assert.deepEqual(scanRepository(root), []);
  assert.deepEqual(contentIssues('.env.example', bytes('PCUP_HOST=localhost\nPCUP_PLAIN=0\nPCUP_ALLOWED_HOSTS=\n')), []);
});

test('사설 주소·내부 도메인·개인 경로·인증값을 차단한다', () => {
  for (const text of [privateAddress, ['device', 'ts', 'net'].join('.'),
    ['host', 'local'].join('.'), ['C:', 'Users', 'fixture'].join('\\'),
    token, `password="${'x'.repeat(12)}"`, ['https:', '', 'user:pass' + '@example.com'].join('/')]) {
    assert.ok(contentIssues('README.md', bytes(text)).length > 0);
  }
  for (const prefix of ['fc42', 'fd12', 'fe80']) {
    assert.ok(contentIssues('README.md', bytes(`https://[${prefix}::1]`)).length > 0);
  }
});

test('환경 예시의 실제 값과 바이너리·대용량 내용을 거부한다', () => {
  assert.ok(contentIssues('.env.example', bytes('PCUP_HOST=example.com')).includes('env-example-value'));
  assert.deepEqual(contentIssues('README.md', Buffer.from([0xff])), ['non-text']);
  assert.deepEqual(contentIssues('README.md', Buffer.alloc(2 * 1024 * 1024 + 1)), ['oversize']);
});

test('경로를 바꾼 내부 파일과 미승인 형식을 거부한다', () => {
  for (const name of ['docs/vault/index.md', '.agents/config.md', 'src/key.pem',
    '.env.production', 'docs/notes.local.md', 'public/export.zip', 'docs/notes.bin']) {
    assert.ok(pathIssues(name).length > 0);
  }
});

test('추적되지 않은 파일의 민감정보도 검사한다', (t) => {
  const { root, put } = fixture(t);
  put('README.md', privateAddress);
  assert.ok(scanRepository(root).some((item) => item.rule === 'private-ipv4'));
});

test('작업 파일을 정리해도 stage에 남은 비밀값을 차단한다', (t) => {
  const { root, git, put } = fixture(t);
  put('README.md', token);
  git('add', 'README.md');
  put('README.md', '공개 문서');
  const result = scanRepository(root, 'staged');
  assert.ok(result.some((item) => item.rule === 'provider-token'));
  assert.ok(!JSON.stringify(result).includes(token), '검출 값을 결과에 넣지 않습니다');
});

test('무시 규칙을 강제로 우회해 stage한 파일을 거부한다', (t) => {
  const { root, git, put } = fixture(t);
  put('.gitignore', '.env*\n');
  put('.env.local', 'PCUP_PLAIN=0');
  git('add', '-f', '.env.local');
  assert.ok(scanRepository(root, 'staged').some((item) => item.rule === 'private-file'));
});

test('무시된 내부 자료 폴더도 반입을 거부한다', (t) => {
  const { root, put } = fixture(t);
  put('.gitignore', 'vault/\n');
  put('vault/notes.md', '비공개 합성 자료');
  assert.ok(scanRepository(root).some((item) => item.rule === 'private-directory'));
});

test('무시된 junction 또는 디렉터리 링크도 대상을 읽지 않고 차단한다', (t) => {
  const { root, put } = fixture(t);
  const target = mkdtempSync(join(tmpdir(), 'papercup-link-target-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  put('.gitignore', 'linked/\n');
  symlinkSync(target, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  // 정리 순서와 무관하게 링크 자체를 제거합니다.
  t.after(() => rmSync(join(root, 'linked'), { recursive: true, force: true }));
  assert.ok(scanRepository(root).some((item) => item.rule === 'filesystem-link'));
});

test('하드 링크 파일을 차단한다', (t) => {
  const { root, put } = fixture(t);
  put('README.md', '합성 문서');
  linkSync(join(root, 'README.md'), join(root, 'AGENTS.md'));
  assert.ok(scanRepository(root).some((item) => item.rule === 'hard-link'));
});

test('checkout에서 일반 파일로 보이는 Git 링크와 submodule도 차단한다', (t) => {
  const { root, git, put } = fixture(t);
  put('README.md', '상대 경로');
  const oid = git('hash-object', '-w', 'README.md').trim();
  for (const mode of ['120000', '160000']) {
    git('update-index', '--add', '--cacheinfo', `${mode},${oid},README.md`);
    assert.ok(scanRepository(root, 'staged').some((item) => item.rule === 'git-link-or-submodule'));
  }
});

test('산출물의 민감정보와 소스맵을 차단한다', (t) => {
  const { root, put } = fixture(t);
  put('dist/index.html', '<html></html>');
  assert.deepEqual(scanRepository(root, 'dist'), []);
  put('dist/assets/app.js', `const endpoint = '${privateAddress}';`);
  put('dist/assets/app.js.map', '{}');
  const result = scanRepository(root, 'dist');
  assert.ok(result.some((item) => item.rule === 'private-ipv4'));
  assert.ok(result.some((item) => item.rule === 'unapproved-artifact'));
});

test('제품 PNG 경로와 메타데이터 없는 이미지 구조만 허용한다', () => {
  const chunk = (type, data = Buffer.alloc(0)) => {
    const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
    return Buffer.concat([size, Buffer.from(type), data, Buffer.alloc(4)]);
  };
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = chunk('IHDR', Buffer.alloc(13));
  const image = chunk('IDAT', Buffer.from([1]));
  const end = chunk('IEND');
  const png = Buffer.concat([sig, header, image, end]);
  assert.deepEqual(pathIssues('src/assets/title.png'), []);
  assert.deepEqual(contentIssues('src/assets/title.png', png), []);
  assert.deepEqual(contentIssues('assets/title-hash.png', png), []);
  for (const bad of [Buffer.from('not an image'), Buffer.concat([png, Buffer.from('private')]), Buffer.concat([sig, header, chunk('tEXt', Buffer.from('private')), image, end]), png.subarray(0, png.length - 1)]) {
    assert.ok(contentIssues('src/assets/title.png', bad).includes('invalid-image'));
  }
  assert.ok(pathIssues('docs/title.png').length > 0);
});
