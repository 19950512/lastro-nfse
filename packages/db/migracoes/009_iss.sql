ALTER TABLE extracao DROP CONSTRAINT extracao_tipo_check;
ALTER TABLE extracao ADD CONSTRAINT extracao_tipo_check
  CHECK (tipo IN ('texto', 'tabelas', 'leiaute', 'aliquotas', 'ignorado', 'falha'));

CREATE OR REPLACE VIEW extracao_vigente AS
SELECT DISTINCT ON (x.snapshot_id) x.id, x.snapshot_id, si.documento_id, si.fonte_id, x.tipo, x.versao_extrator, x.criada_em
  FROM extracao x JOIN snapshot_indexavel si ON si.snapshot_id = x.snapshot_id
 WHERE x.tipo IN ('texto', 'tabelas', 'leiaute', 'aliquotas')
 ORDER BY x.snapshot_id, x.criada_em DESC, x.id DESC;

CREATE TABLE tabela_aliquota_iss (
  extracao_id      uuid PRIMARY KEY REFERENCES extracao (id),
  snapshot_id      uuid NOT NULL REFERENCES snapshot (id),
  documento_id     uuid NOT NULL REFERENCES documento (id),
  fonte_id         text NOT NULL,
  data_referencia  date,
  linhas           integer NOT NULL CHECK (linhas > 0),
  recusadas        integer NOT NULL CHECK (recusadas >= 0),
  arquivos         text[] NOT NULL
);

CREATE TABLE municipio_iss (
  extracao_id  uuid NOT NULL REFERENCES tabela_aliquota_iss (extracao_id),
  codigo_ibge  text NOT NULL CHECK (codigo_ibge ~ '^[0-9]{7}$'),
  uf           text NOT NULL CHECK (uf ~ '^[A-Z]{2}$'),
  nome         text NOT NULL CHECK (length(nome) BETWEEN 1 AND 120),
  PRIMARY KEY (extracao_id, codigo_ibge)
);

/* invariant: os valores ficam como publicados (alíquota com vírgula decimal, código de serviço com pontos), para que a
   linha citada seja reconstruída byte a byte; `arquivo` + `linha` localizam a linha no CSV do snapshot. */
CREATE TABLE aliquota_iss (
  extracao_id     uuid NOT NULL,
  arquivo         text NOT NULL CHECK (arquivo ~ '^[A-Z]{2}\.csv$'),
  linha           integer NOT NULL CHECK (linha >= 2),
  codigo_ibge     text NOT NULL,
  codigo_servico  text NOT NULL CHECK (codigo_servico ~ '^[0-9]{2}\.[0-9]{2}\.[0-9]{2}\.[0-9]{3}$'),
  incidencia      text NOT NULL CHECK (incidencia ~ '^[0-9]{2}\.[0-9]{2}\.[0-9]{2}\.[0-9]{3}$'),
  aliquota        text CHECK (aliquota ~ '^[0-9]{1,3}(,[0-9]{1,4})?$'),
  inicio          date NOT NULL,
  fim             date,
  PRIMARY KEY (extracao_id, arquivo, linha),
  FOREIGN KEY (extracao_id, codigo_ibge) REFERENCES municipio_iss (extracao_id, codigo_ibge)
);
CREATE INDEX aliquota_iss_consulta ON aliquota_iss (extracao_id, codigo_ibge, codigo_servico);

/* why: um pacote novo sai com outro nome de arquivo (outra URL, outro documento), e o antigo continua arquivado.
   Vale o de data de extração mais recente; empate (ou data ausente) desempata pela coleta. Versão anômala não
   liberada já fica fora por extracao_vigente. */
CREATE VIEW tabela_aliquota_iss_vigente AS
SELECT t.extracao_id, t.snapshot_id, t.documento_id, t.fonte_id, t.data_referencia, t.linhas, t.recusadas, t.arquivos,
       d.url, s.sha256, s.coletado_em,
       (SELECT max(v.verificado_em) FROM verificacao_coleta v WHERE v.documento_id = t.documento_id AND v.sha256 = s.sha256) AS verificado_em
  FROM tabela_aliquota_iss t
  JOIN extracao_vigente x ON x.id = t.extracao_id
  JOIN snapshot s ON s.id = t.snapshot_id
  JOIN documento d ON d.id = t.documento_id
 ORDER BY t.data_referencia DESC NULLS LAST, s.coletado_em DESC, t.extracao_id
 LIMIT 1;

DO $$
DECLARE
  tabela text;
BEGIN
  FOREACH tabela IN ARRAY ARRAY['tabela_aliquota_iss', 'municipio_iss', 'aliquota_iss'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION recusar_alteracao()', tabela || '_so_insercao', tabela);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION recusar_alteracao()', tabela || '_sem_truncate', tabela);
  END LOOP;
END
$$;

GRANT INSERT ON tabela_aliquota_iss, municipio_iss, aliquota_iss TO lastro_processador;
GRANT SELECT ON tabela_aliquota_iss, municipio_iss, aliquota_iss, tabela_aliquota_iss_vigente TO lastro_api, lastro_leitor;
