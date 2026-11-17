CREATE TABLE webhook_assinatura (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url                   text NOT NULL CHECK (url LIKE 'https://%'),
  formato               text NOT NULL CHECK (formato IN ('lastro', 'slack')),
  segredo               text NOT NULL CHECK (length(segredo) >= 32),
  fontes                text[],
  tipos                 text[],
  criada_em             timestamptz NOT NULL DEFAULT now(),
  ativa                 boolean NOT NULL DEFAULT true,
  falhas_consecutivas   integer NOT NULL DEFAULT 0,
  desativada_em         timestamptz,
  motivo_desativacao    text
);

CREATE TABLE webhook_entrega (
  assinatura_id      uuid NOT NULL REFERENCES webhook_assinatura (id),
  evento_id          uuid NOT NULL REFERENCES evento_mudanca (id),
  situacao           text NOT NULL CHECK (situacao IN ('pendente', 'entregue', 'falhou')),
  tentativas         integer NOT NULL DEFAULT 0,
  proxima_tentativa  timestamptz NOT NULL DEFAULT now(),
  ultimo_status      integer,
  ultimo_erro        text,
  entregue_em        timestamptz,
  PRIMARY KEY (assinatura_id, evento_id)
);
CREATE INDEX webhook_entrega_pendente ON webhook_entrega (proxima_tentativa) WHERE situacao = 'pendente';

GRANT USAGE ON SCHEMA public TO lastro_notificador;
GRANT SELECT ON documento, evento_mudanca TO lastro_notificador;
GRANT SELECT, UPDATE ON webhook_assinatura TO lastro_notificador;
GRANT SELECT, INSERT, UPDATE ON webhook_entrega TO lastro_notificador;
