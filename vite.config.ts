import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, 'PCUP_');
  const host = env.PCUP_HOST?.trim() || 'localhost';
  const plain = env.PCUP_PLAIN === '1';
  const allowedHosts = (env.PCUP_ALLOWED_HOSTS ?? '')
    .split(',').map((value) => value.trim()).filter(Boolean);

  // 넓은 도메인 허용이나 URL 오입력을 조용히 수용하지 않습니다.
  if (allowedHosts.some((value) =>
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(value))) {
    throw new Error('PCUP_ALLOWED_HOSTS에는 정확한 호스트 이름만 지정합니다.');
  }

  return {
    plugins: plain ? [] : [basicSsl()],
    // public/의 검토되지 않은 파일이 산출물에 자동 복사되는 경로를 닫습니다.
    publicDir: false,
    server: {
      host,
      port: 5173,
      strictPort: true,
      allowedHosts,
      fs: {
        strict: true,
        allow: [root],
        deny: ['.env', '.env.*', '**/.git/**', '**/*.{pem,key,crt,cer,p12,pfx}',
          '**/*.local.*', '**/docs/**', '**/AGENTS.md', '**/SECURITY.md'],
      },
    },
    preview: { host, port: 4173, strictPort: true, allowedHosts },
    build: {
      sourcemap: false,
      // 상수 배열을 점으로 연결한 문자열로 바꾸면 UUID 표가 IP 주소로 오인됩니다.
      // 원래 배열 구조를 보존하고 이름·공백만 축소해 산출물 검사를 유지합니다.
      rolldownOptions: { output: { minify: { compress: false, mangle: true } } },
    },
  };
});
