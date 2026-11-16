// Baixa o navegador interno usado pelo Remotion para renderizar (executado pelo instalador).
// Se não houver internet, o próprio AutoCut baixa na primeira exportação.
const {ensureBrowser} = require('@remotion/renderer');

// Sem internet, o Remotion falha fora da promessa: trata aqui para o instalador seguir normalmente.
const giveUp = (e) => {
  console.log('Nao foi possivel baixar agora:', e && e.message ? e.message : e);
  console.log('O AutoCut vai tentar de novo na primeira exportacao.');
  process.exit(0);
};
process.on('unhandledRejection', giveUp);
process.on('uncaughtException', giveUp);

let last = -10;
ensureBrowser({
  onBrowserDownload: () => {
    console.log('Baixando o navegador de renderizacao (cerca de 100 MB)...');
    return {
      version: null,
      onProgress: ({percent}) => {
        const p = Math.floor(percent * 100);
        if (p >= last + 10) {
          last = p;
          console.log(`  ${p}%`);
        }
      },
    };
  },
})
  .then((status) => {
    console.log('Navegador pronto:', status.type);
  })
  .catch(giveUp);
