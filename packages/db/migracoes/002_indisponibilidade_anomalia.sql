ALTER TABLE evento_mudanca DROP CONSTRAINT evento_mudanca_tipo_check;
ALTER TABLE evento_mudanca ADD CONSTRAINT evento_mudanca_tipo_check CHECK (
  tipo IN ('documento-novo', 'nova-versao', 'link-removido', 'documento-indisponivel', 'documento-restabelecido')
);
ALTER TABLE evento_mudanca ADD COLUMN anomalia text;
CREATE INDEX evento_mudanca_documento_recente ON evento_mudanca (documento_id, detectado_em DESC);
CREATE INDEX evento_mudanca_anomalia ON evento_mudanca (detectado_em) WHERE anomalia IS NOT NULL;
