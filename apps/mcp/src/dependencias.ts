import { FONTES } from '@lastro/core';
import { abrirApi, type ApiAberta } from '@lastro/db';
import { criarModeloAnthropic, criarServicoPerguntas, criarServicoVerificacoes, modeloConfigurado, modeloIndisponivel, type ClienteModelo } from '@lastro/llm';
import type { DependenciasMcp } from './ferramentas.ts';

export async function abrirDependencias(ambiente: NodeJS.ProcessEnv = process.env): Promise<{ deps: DependenciasMcp; aberta: ApiAberta }> {
  const orcamentoDiarioUsd = Number(ambiente.LASTRO_LLM_ORCAMENTO_DIARIO_USD ?? 20);
  if (!Number.isFinite(orcamentoDiarioUsd) || orcamentoDiarioUsd < 0) throw new Error('LASTRO_LLM_ORCAMENTO_DIARIO_USD inválido');
  // invariant: modelo fora da lista suportada derruba a subida (o erro sobe); só a falta de credencial vira modo indisponível.
  const nomeModelo = modeloConfigurado(ambiente, 'respostas');
  let modelo: ClienteModelo;
  try {
    modelo = criarModeloAnthropic({ modelo: nomeModelo });
  } catch {
    modelo = modeloIndisponivel();
  }
  const aberta = await abrirApi(ambiente);
  return {
    aberta,
    deps: {
      consultas: aberta.consultas,
      conhecimento: aberta.conhecimento,
      fontes: FONTES,
      perguntas: criarServicoPerguntas({ clientes: aberta.clientes, conhecimento: aberta.conhecimento, fatos: aberta.fatos, modelo, fontes: FONTES, orcamentoDiarioUsd }),
      fatos: aberta.fatos,
      verificacoes: criarServicoVerificacoes({
        clientes: aberta.clientes,
        verificacoes: aberta.verificacoes,
        conhecimento: aberta.conhecimento,
        fatos: aberta.fatos,
        modelo,
        fontes: FONTES,
        orcamentoDiarioUsd,
      }),
    },
  };
}
