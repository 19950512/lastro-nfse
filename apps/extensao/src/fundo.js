import { montarUrlVerificacao } from './url.js';

const MENU = 'lastro-checar';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: MENU, title: 'Checar no Lastro: isso é verdade?', contexts: ['selection'] });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== MENU) return;
  void chrome.storage.sync.get('portal').then(({ portal }) => {
    const destino = montarUrlVerificacao(portal, info.selectionText);
    // why: sem portal configurado (ou com endereço recusado), a extensão não manda o texto a lugar nenhum.
    if (destino === null) return chrome.runtime.openOptionsPage();
    return chrome.tabs.create({ url: destino });
  });
});
