import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BYTES = 2 * 1024 * 1024;
const rootFiles = new Set([
  '.editorconfig', '.env.example', '.gitattributes', '.gitignore',
  'AGENTS.md', 'README.md', 'SECURITY.md', 'index.html',
  'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts',
]);
const forbiddenPart = /^(?:\.(?:agents|codex|claude|opencode|obsidian|harness|superpowers|gstack|omo|worktrees|local|local-work-records)|vault|obsidian-vault|local|private|internal|secrets|credentials|certs)$/i;
const forbiddenFile = /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|id_(?:rsa|ed25519)|LOCAL\.md|NOTES\.md)$|\.(?:local\.[^/]+|pem|key|crt|cer|p12|pfx|jks|keystore|bak|backup|zip|7z|lnk|url)$/i;
const rules = [
  ['private-key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/],
  ['provider-token', /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/],
  ['credential-value', /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\b["']?\s*[:=]\s*["'][^"'\r\n]{8,}["']/i],
  ['url-credentials', /https?:\/\/[^\s/@]+:[^\s/@]+@/i],
  ['private-ipv4', /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01])|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])|169\.254)\.\d{1,3}\.\d{1,3}\b/],
  ['private-ipv6', /(?:^|[\s["'=/])(?:f[cd][\da-f]{2}|fe[89ab][\da-f]):[\da-f:]+/im],
  ['internal-host', /(?<![\w.-])[a-z0-9][a-z0-9.-]*\.(?:ts\.net|local|internal|lan|home\.arpa)(?![\w.-])/i],
  ['absolute-path', /\b[A-Z]:[\\/]|\/(?:Users|home|mnt|Volumes)\/[^\s/]+|\\\\[a-z0-9._-]+\\/i],
  ['private-resource', /(?:obsidian|file):\/\/|\[\[[^\]\n]*(?:vault|handoff|decisions|sources|projects)[^\]\n]*\]\]/i],
];

// 제품 이미지에는 텍스트·메타데이터 청크와 파일 뒤의 추가 데이터를 허용하지 않습니다.
function isPlainPng(bytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(signature)) return false;
  let offset = 8, header = false, image = false, end = false;
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset);
    if (size > bytes.length - offset - 12) return false;
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'IHDR' && !header && offset === 8 && size === 13) header = true;
    else if (type === 'IDAT' && header && !end) image = true;
    else if (type === 'IEND' && header && image && !end && size === 0) end = true;
    else return false;
    offset += size + 12;
    if (end) return offset === bytes.length;
  }
  return false;
}

export function contentIssues(name, bytes) {
  if (bytes.length > MAX_BYTES) return ['oversize'];
  if (/^(?:src\/assets|assets)\/[\w.-]+\.png$/.test(name)) return isPlainPng(bytes) ? [] : ['invalid-image'];
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return ['non-text']; }
  if (text.includes('\0')) return ['non-text'];
  const issues = rules.filter(([, rule]) => rule.test(text)).map(([id]) => id);
  if (name === '.env.example') {
    const lines = text.split(/\r?\n/).map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    if (lines.some((line) => !/^(?:PCUP_HOST=localhost|PCUP_PLAIN=0|PCUP_ALLOWED_HOSTS=)$/.test(line))) {
      issues.push('env-example-value');
    }
  }
  return issues;
}

export function pathIssues(name) {
  if (name.split('/').some((part) => forbiddenPart.test(part)) ||
    (name !== '.env.example' && forbiddenFile.test(name))) return ['private-file'];
  if (rootFiles.has(name) || /^src\/assets\/[\w-]+\.png$/.test(name)) return [];
  if (/^(?:src|tests|scripts)\/(?:[\w-]+\/)*[\w.-]+\.(?:ts|mjs|css)$/.test(name)) return [];
  if (/^docs\/(?:[\w-]+\/)*[\w.-]+\.md$/.test(name)) return [];
  if (name === '.github/workflows/ci.yml') return [];
  return ['unapproved-path'];
}

export function scanRepository(root, mode = 'worktree') {
  const findings = [];
  const report = (name, ids) => ids.forEach((rule) => findings.push({ path: name, rule }));
  const git = (args, options = {}) => execFileSync('git', args, {
    cwd: root, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...options,
  });
  const scanBytes = (name, bytes) => report(name, contentIssues(name, bytes));

  // lstat은 링크 대상을 따라가지 않습니다. 무시된 링크도 읽기 전에 거부합니다.
  function walk(dir, prefix, artifacts = false) {
    for (const entry of readdirSync(dir)) {
      const name = prefix ? `${prefix}/${entry}` : entry;
      if (!prefix && entry === '.git' && !artifacts) continue;
      const full = join(dir, entry);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) { report(name, ['filesystem-link']); continue; }
      if (prefix && entry === '.git') { report(name, ['nested-repository']); continue; }
      if (!artifacts && ['node_modules', 'dist', '.vite', 'coverage', 'test-results', 'playwright-report'].includes(entry)) continue;
      if (!artifacts && forbiddenPart.test(entry)) { report(name, ['private-directory']); continue; }
      if (stat.isDirectory()) {
        walk(full, name, artifacts);
      } else if (stat.isFile()) {
        if (stat.nlink > 1) report(name, ['hard-link']);
        if (artifacts) {
          if (!/\.(?:html|js|css)$/.test(name) && !/^assets\/[\w.-]+\.png$/.test(name)) report(name, ['unapproved-artifact']);
          if (stat.size > MAX_BYTES) report(name, ['oversize']);
          else scanBytes(name, readFileSync(full));
        }
      } else report(name, ['special-file']);
    }
  }

  if (mode === 'dist') {
    const dist = join(root, 'dist');
    const stat = lstatSync(dist);
    if (stat.isSymbolicLink() || !stat.isDirectory()) report('dist', ['filesystem-link']);
    else walk(dist, '', true);
    return findings;
  }

  const index = git(['ls-files', '--stage', '-z']).toString('utf8').split('\0').filter(Boolean);
  for (const record of index) {
    const tab = record.indexOf('\t');
    const [fileMode, oid, stage] = record.slice(0, tab).split(' ');
    const name = record.slice(tab + 1);
    report(name, pathIssues(name));
    if (stage !== '0') { report(name, ['unmerged-index']); continue; }
    if (!['100644', '100755'].includes(fileMode)) { report(name, ['git-link-or-submodule']); continue; }
    const size = Number(git(['cat-file', '-s', oid]).toString());
    if (size > MAX_BYTES) report(name, ['oversize']);
    else scanBytes(name, git(['cat-file', 'blob', oid]));
  }
  if (mode === 'staged') return findings;

  walk(root, '');
  const names = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
    .toString('utf8').split('\0').filter(Boolean);
  for (const name of new Set(names)) {
    report(name, pathIssues(name));
    let full = root;
    let stat;
    let safe = true;
    for (const part of name.split('/')) {
      full = join(full, part);
      try { stat = lstatSync(full); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        safe = false; break; // 삭제된 작업 파일도 위에서 인덱스 원문을 검사합니다.
      }
      if (stat.isSymbolicLink()) { report(name, ['filesystem-link']); safe = false; break; }
    }
    if (!safe) continue;
    if (!stat.isFile()) { report(name, ['non-regular-file']); continue; }
    if (stat.size > MAX_BYTES) report(name, ['oversize']);
    else scanBytes(name, readFileSync(full));
  }
  return findings;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0] && !['--staged', '--dist'].includes(args[0]))) {
    console.error('사용법: node scripts/check-repo.mjs [--staged|--dist]');
    process.exitCode = 1;
  } else {
    try {
      const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
      const findings = scanRepository(root, args[0]?.slice(2) || 'worktree');
      for (const finding of findings) console.error(`${JSON.stringify(finding.path)}: ${finding.rule}`);
      console.log(`저장소 검사: ${findings.length === 0 ? '통과' : `${findings.length}건 차단`}`);
      process.exitCode = findings.length ? 1 : 0;
    } catch {
      // Git 오류와 파일 접근 오류의 원문에는 로컬 경로가 포함될 수 있습니다.
      console.error('검사를 완료하지 못했습니다. Git 상태와 파일 접근 권한을 확인하세요.');
      process.exitCode = 1;
    }
  }
}
