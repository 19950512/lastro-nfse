import { describe, expect, it } from 'vitest';
import { configBanco, configS3, ErroConfiguracao } from './config.ts';

const AMBIENTE = {
  LASTRO_PG_COLETOR_SENHA: 'c',
  LASTRO_PG_LEITOR_SENHA: 'l',
  LASTRO_PG_ADMIN_SENHA: 'a',
  LASTRO_S3_ENDPOINT: 'http://127.0.0.1:59000',
  LASTRO_S3_BUCKET: 'b',
  LASTRO_S3_ACCESS_KEY: 'k',
  LASTRO_S3_SECRET_KEY: 's',
};

describe('configBanco', () => {
  it('usa um usuário por papel', () => {
    expect(configBanco('coletor', AMBIENTE).user).toBe('lastro_coletor');
    expect(configBanco('leitor', AMBIENTE).user).toBe('lastro_leitor');
    expect(configBanco('admin', AMBIENTE).user).toBe('lastro_admin');
  });

  it('falha fechado sem senha', () => {
    expect(() => configBanco('coletor', {})).toThrow(ErroConfiguracao);
  });

  it('exige certificado válido quando SSL está ligado', () => {
    expect(configBanco('leitor', { ...AMBIENTE, LASTRO_PG_SSL: 'exigir' }).ssl).toEqual({ rejectUnauthorized: true });
    expect(() => configBanco('leitor', { ...AMBIENTE, LASTRO_PG_SSL: 'talvez' })).toThrow(/LASTRO_PG_SSL/);
  });
});

describe('configS3', () => {
  it('lê a retenção e recusa valor inválido', () => {
    expect(configS3(AMBIENTE).retencaoDias).toBe(3650);
    expect(() => configS3({ ...AMBIENTE, LASTRO_S3_RETENCAO_DIAS: '0' })).toThrow(ErroConfiguracao);
  });
});
