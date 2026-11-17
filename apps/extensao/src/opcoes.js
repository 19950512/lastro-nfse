import { validarPortal } from './url.js';

const formulario = document.getElementById('formulario');
const campo = document.getElementById('portal');
const situacao = document.getElementById('situacao');

void chrome.storage.sync.get('portal').then(({ portal }) => {
  if (typeof portal === 'string' && campo instanceof HTMLInputElement) campo.value = portal;
});

formulario?.addEventListener('submit', (evento) => {
  evento.preventDefault();
  if (!(campo instanceof HTMLInputElement) || situacao === null) return;
  const origem = validarPortal(campo.value);
  if (origem === null) {
    situacao.textContent = 'Endereço recusado: use o endereço https:// do portal.';
    return;
  }
  void chrome.storage.sync.set({ portal: origem }).then(() => {
    campo.value = origem;
    situacao.textContent = 'Salvo.';
  });
});
