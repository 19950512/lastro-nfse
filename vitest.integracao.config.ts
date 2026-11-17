import { defineConfig } from 'vitest/config';

// why: testes de integração precisam das senhas locais do .env; sem o arquivo, falham na configuração.
try {
  process.loadEnvFile('.env');
} catch {
  console.warn('.env não encontrado: rode pnpm infra:env e pnpm infra:subir');
}

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.integracao.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
