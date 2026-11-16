# AutoCut

Transforma uma gravação bruta em três tipos de vídeo para o YouTube: melhores momentos (16:9),
Shorts (9:16) e o vídeo longo enxuto. O Claude decide os cortes e os textos; o Remotion renderiza.

## Como usar

1. Instale o [Node.js](https://nodejs.org) versão 20 ou mais nova.
2. Dê dois cliques em `iniciar.bat`. Na primeira vez ele instala as dependências (alguns minutos),
   cria o arquivo `.env` e abre a tela no navegador (http://localhost:5173).
3. Abra o `.env` no Bloco de Notas, cole sua chave em `ANTHROPIC_API_KEY`, confira `VIDEOS_DIR`
   e `CHANNEL_NAME`, e inicie de novo.
4. Na tela: escolha o vídeo, clique em **Analisar vídeo**, depois **Gerar plano com o Claude**,
   revise os cortes e clique em **Exportar**. Os vídeos prontos vão para a pasta `prontos`.

Sem a chave da API o programa ainda funciona, mas o plano é montado só pelos picos de áudio.

## Como funciona

| Etapa | O que acontece | Arquivo |
| --- | --- | --- |
| Análise | ffmpeg cria uma versão leve (540p), mede o volume por segundo, detecta mudanças de cena, tira até 48 quadros (espalhados e nos picos de som) e, se o Whisper estiver instalado, transcreve a fala | `src/server/analyze.ts` |
| Plano | Os quadros e os dados vão para o Claude, que devolve um JSON com os trechos, letreiros, velocidade, título, descrição, tags e ideia de thumbnail | `src/server/planner.ts` |
| Revisão | Prévia com o player do Remotion; dá para editar cada trecho à mão ou pedir alterações em texto | `src/web/App.tsx` |
| Exportação | ffmpeg recorta do original só os trechos usados e o Remotion monta o vídeo final | `src/server/render.ts` |

O visual (cores, fontes, abertura, letreiros, tela final) fica em `src/remotion/AutoCut.tsx`.
As instruções de edição dadas ao Claude ficam no começo de `src/server/planner.ts`.
Para mexer no visual com recarga ao vivo: `npm run studio`.

## Configurações

O botão **Configurações** no topo da tela guarda as chaves do Claude, do Gemini e da ElevenLabs
(cada uma com um botão **Testar**), o modelo do Claude (a lista vem da sua conta), as pastas
(com o espaço livre de cada disco) e as opções de placa de vídeo. Tudo é gravado no `.env` e vale
na hora, sem reiniciar. As chaves nunca voltam inteiras para a tela, e o servidor só aceita
acessos deste computador.

## Estilos

Cada canal ou cliente pode ter o seu estilo: cor de destaque, cor das letras, fundo dos letreiros,
fontes, nome do canal e uma orientação de edição para o Claude (tipo de vídeo, ritmo, tom).
Crie e edite na seção **Estilo** da tela; a prévia muda na hora. Cada estilo é um arquivo JSON
na pasta `estilos`, que pode ser copiado para outro computador.

- As cores e fontes valem imediatamente para a prévia e a exportação.
- A orientação de edição só muda os cortes ao gerar o plano de novo ou pedir uma alteração.
- As fontes precisam estar instaladas no computador.

## Efeitos

O Claude escolhe os efeitos ao montar o plano, e tudo pode ser ajustado na tabela de trechos:

- **Entrada do trecho:** fusão, flash, deslizar, zoom ou corte seco.
- **Impacto:** um soco de zoom com tremida no instante indicado.
- **Replay:** repete o ponto alto do trecho em câmera lenta.
- **Letreiros** entram palavra por palavra.
- **Setas de apontamento:** o botão "Detectar apontamentos neste vídeo" manda um quadro a cada 2 s
  dos trechos para o Claude, que devolve onde alguém aponta para algo. Cada seta pode ser
  renomeada, reposicionada (x, y em %) ou removida na lista.
- **Enquadramento vertical (Shorts):** preencher a tela, mais aberto ou imagem inteira com fundo
  desfocado. Use os dois últimos quando a gravação já tem legendas na imagem.
- **Música de fundo:** coloque arquivos MP3 na pasta `musicas` (dentro da pasta dos vídeos),
  escolha a música e o volume abaixo da prévia. Ela toca em laço, entra e sai com rampa.
- **Gerar música:** com `GEMINI_API_KEY` (Google Lyria) ou `ELEVENLABS_API_KEY` no `.env`, o botão
  "Gerar música para este vídeo" cria uma trilha instrumental. No modo automático o Claude escolhe
  o estilo pelo canal e pelo conteúdo; no modo "Descrever" você escreve o que quer.
- **Vinheta de 10 s:** o botão "Gerar vinheta de 10 s" monta cortes rápidos dos momentos mais
  importantes, em duas versões (horizontal e vertical), com o título no final. Os cortes podem
  ser ajustados na tabela como em qualquer outro vídeo.
- **Efeitos: Sem / Normal / Intenso** liga, desliga ou reforça tudo de uma vez.

## O que saber

- **Espaço em disco:** a pasta `work` guarda a versão leve e os recortes. Reserve cerca de 1/3 do
  tamanho do vídeo bruto, mais o tamanho dos vídeos prontos. `WORK_DIR` pode apontar para outro disco.
- **Custo:** cada plano envia até 48 imagens pequenas e um resumo em texto para a API. Pedidos de
  alteração em texto não reenviam as imagens. `MAX_FRAMES` controla a quantidade de quadros.
- **Tempo de exportação:** o Remotion renderiza quadro a quadro. Melhores momentos e Shorts saem
  em minutos; o vídeo longo pode levar bem mais que a duração dele.
- **Fala:** legendas automáticas só aparecem se o Whisper estiver instalado
  (`pip install openai-whisper`). Sem ele, a etapa é pulada.
- **Licença do Remotion:** gratuito para uso individual e empresas de até 3 pessoas.

## Recompilar o instalador (.exe)

Para gerar novamente o instalador do Windows (`installer/out/AutoCut-Setup-<versão>.exe`):

- **No Windows:** instale o [NSIS](https://nsis.sourceforge.io/) (`winget install NSIS.NSIS`) e dê dois cliques em `recompilar-instalador.bat` (ou rode `npm run installer:win`). Para instalar o NSIS automaticamente na primeira vez: `recompilar-instalador.bat -InstallNsis`. Para limpar o cache antes de compilar: `recompilar-instalador.bat -Clean`.
- **No Linux ou WSL:** instale o NSIS (`sudo apt install nsis`) e rode `npm run installer` (`bash installer/build.sh`).
- **Pelo GitHub Actions (automático):** a cada push na `main`, envio de tag `vX.Y.Z` ou clique em *Run workflow* na aba **Actions**, o workflow `.github/workflows/release.yml` compila o `AutoCut-Setup-<versão>.exe` e o disponibiliza para download na aba **Releases** do repositório.
