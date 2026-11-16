; Instalador do AutoCut para Windows 10/11 (64 bits).
; Gerado por installer/build.sh, que prepara a pasta STAGE com o Node.js, as dependências
; já compiladas para Windows e o código do AutoCut.

; Instalador de 64 bits (o AutoCut só roda no Windows x64).
Target amd64-unicode
SetCompressor /SOLID lzma
SetCompressorDictSize 64

!ifndef VERSION
  !define VERSION "0.1.0"
!endif
!ifndef STAGE
  !define STAGE "stage"
!endif
!ifndef OUTFILE
  !define OUTFILE "AutoCut-Setup-${VERSION}.exe"
!endif

!define APPNAME "AutoCut"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\AutoCut"

!include "MUI2.nsh"
!include "x64.nsh"
!include "LogicLib.nsh"
!include "WinVer.nsh"
!include "FileFunc.nsh"

Name "${APPNAME}"
OutFile "${OUTFILE}"
; Instala só para o usuário atual: não pede administrador e a pasta fica gravável
; (o AutoCut grava configurações, estilos e arquivos de trabalho ao lado do programa).
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\AutoCut"
InstallDirRegKey HKCU "Software\AutoCut" "InstallDir"
BrandingText "AutoCut ${VERSION}"
ShowInstDetails show

VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=1046 "ProductName" "AutoCut"
VIAddVersionKey /LANG=1046 "FileDescription" "Instalador do AutoCut"
VIAddVersionKey /LANG=1046 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1046 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=1046 "LegalCopyright" "AutoCut"

!define MUI_ICON "autocut.ico"
!define MUI_UNICON "autocut.ico"
!define MUI_ABORTWARNING

!define MUI_WELCOMEPAGE_TITLE "Instalar o AutoCut"
!define MUI_WELCOMEPAGE_TEXT "O AutoCut transforma gravações brutas em vídeos para o YouTube (melhores momentos, Shorts, vídeo longo e vinhetas), com cortes sugeridos pelo Claude.$\r$\n$\r$\nTudo o que ele precisa já vem incluído: Node.js, ffmpeg e o motor de renderização. Não é preciso instalar mais nada nem ter permissão de administrador.$\r$\n$\r$\nDica: instale em um disco com bastante espaço livre. Os arquivos de trabalho ficam na pasta do AutoCut."
!insertmacro MUI_PAGE_WELCOME

!define MUI_DIRECTORYPAGE_TEXT_TOP "Escolha a pasta do AutoCut. Ela precisa de cerca de 1 GB, mais espaço para os arquivos de trabalho (cerca de 1/3 do tamanho de cada vídeo bruto).$\r$\n$\r$\nEvite C:\Arquivos de Programas: o AutoCut precisa gravar dentro da própria pasta."
!insertmacro MUI_PAGE_DIRECTORY

!insertmacro MUI_PAGE_INSTFILES

!define MUI_FINISHPAGE_RUN "$INSTDIR\AutoCut.cmd"
!define MUI_FINISHPAGE_RUN_TEXT "Abrir o AutoCut agora"
!define MUI_FINISHPAGE_SHOWREADME "$INSTDIR\LEIA-ME.txt"
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Ler as instruções"
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "PortugueseBR"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "O AutoCut precisa do Windows de 64 bits."
    Abort
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_ICONSTOP "O AutoCut precisa do Windows 10 ou 11."
    Abort
  ${EndIf}
FunctionEnd

Function .onVerifyInstDir
  ; A pasta de programas do sistema não é gravável sem administrador.
  StrLen $0 "$PROGRAMFILES64"
  StrCpy $1 "$INSTDIR" $0
  ${If} $1 == "$PROGRAMFILES64"
    Abort
  ${EndIf}
  StrLen $0 "$PROGRAMFILES32"
  StrCpy $1 "$INSTDIR" $0
  ${If} $1 == "$PROGRAMFILES32"
    Abort
  ${EndIf}
FunctionEnd

Section "AutoCut" SecMain
  SectionIn RO
  SetOutPath "$INSTDIR"

  ; Se o AutoCut estiver aberto, os arquivos ficam travados.
  DetailPrint "Fechando o AutoCut, se estiver aberto..."
  nsExec::Exec `cmd /c for /f "tokens=5" %p in ('netstat -ano ^| findstr :3001 ^| findstr LISTENING') do taskkill /PID %p /FI "IMAGENAME eq node.exe" /F`
  Pop $0

  ; Atualização: remove o código e as dependências antigas, mantendo os dados do usuário.
  RMDir /r "$INSTDIR\src"
  RMDir /r "$INSTDIR\dist"
  RMDir /r "$INSTDIR\node"
  ${If} ${FileExists} "$INSTDIR\node_modules\.remotion\*.*"
    ; Guarda o navegador já baixado para não baixar de novo.
    Rename "$INSTDIR\node_modules\.remotion" "$INSTDIR\.remotion-keep"
  ${EndIf}
  RMDir /r "$INSTDIR\node_modules"

  DetailPrint "Copiando o AutoCut (pode levar alguns minutos)..."
  SetOverwrite on
  File /r "${STAGE}\node"
  File /r "${STAGE}\node_modules"
  File /r "${STAGE}\src"
  File /r "${STAGE}\dist"
  File "${STAGE}\package.json"
  File "${STAGE}\tsconfig.json"
  File "${STAGE}\.env.example"
  File "${STAGE}\AutoCut.cmd"
  File "${STAGE}\LEIA-ME.txt"
  File "${STAGE}\README.md"
  File "${STAGE}\autocut.ico"
  File "${STAGE}\ensure-browser.cjs"

  ${If} ${FileExists} "$INSTDIR\.remotion-keep\*.*"
    Rename "$INSTDIR\.remotion-keep" "$INSTDIR\node_modules\.remotion"
  ${EndIf}

  ; Estilos e configurações do usuário não são sobrescritos numa atualização.
  SetOverwrite off
  SetOutPath "$INSTDIR\estilos"
  File /nonfatal /r "${STAGE}\estilos\*.*"
  SetOutPath "$INSTDIR"
  ${IfNot} ${FileExists} "$INSTDIR\.env"
    CopyFiles /SILENT "$INSTDIR\.env.example" "$INSTDIR\.env"
  ${EndIf}
  SetOverwrite on
  CreateDirectory "$INSTDIR\videos"
  CreateDirectory "$INSTDIR\videos\musicas"

  ; Navegador usado pelo Remotion para renderizar (cerca de 100 MB, baixado da Google).
  DetailPrint "Preparando o motor de renderização (download de cerca de 100 MB)..."
  nsExec::ExecToLog '"$INSTDIR\node\node.exe" "$INSTDIR\ensure-browser.cjs"'
  Pop $0

  ; Atalhos
  CreateDirectory "$SMPROGRAMS\AutoCut"
  CreateShortcut "$SMPROGRAMS\AutoCut\AutoCut.lnk" "$INSTDIR\AutoCut.cmd" "" "$INSTDIR\autocut.ico" 0 SW_SHOWMINIMIZED
  Delete "$SMPROGRAMS\AutoCut\Configurações do AutoCut.lnk"
  CreateShortcut "$SMPROGRAMS\AutoCut\Configurações avançadas (.env).lnk" "$WINDIR\notepad.exe" '"$INSTDIR\.env"'
  CreateShortcut "$SMPROGRAMS\AutoCut\Pasta de vídeos.lnk" "$INSTDIR\videos"
  CreateShortcut "$SMPROGRAMS\AutoCut\Estilos.lnk" "$INSTDIR\estilos"
  CreateShortcut "$SMPROGRAMS\AutoCut\Leia-me.lnk" "$INSTDIR\LEIA-ME.txt"
  CreateShortcut "$SMPROGRAMS\AutoCut\Desinstalar AutoCut.lnk" "$INSTDIR\Desinstalar.exe"
  CreateShortcut "$DESKTOP\AutoCut.lnk" "$INSTDIR\AutoCut.cmd" "" "$INSTDIR\autocut.ico" 0 SW_SHOWMINIMIZED

  ; Desinstalador e registro em "Aplicativos instalados"
  WriteUninstaller "$INSTDIR\Desinstalar.exe"
  WriteRegStr HKCU "Software\AutoCut" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayName" "AutoCut"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTKEY}" "Publisher" "AutoCut"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayIcon" "$INSTDIR\autocut.ico"
  WriteRegStr HKCU "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" '"$INSTDIR\Desinstalar.exe"'
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKCU "${UNINSTKEY}" "EstimatedSize" $0
SectionEnd

Section "Uninstall"
  nsExec::Exec `cmd /c for /f "tokens=5" %p in ('netstat -ano ^| findstr :3001 ^| findstr LISTENING') do taskkill /PID %p /FI "IMAGENAME eq node.exe" /F`
  Pop $0

  RMDir /r "$INSTDIR\node"
  RMDir /r "$INSTDIR\node_modules"
  RMDir /r "$INSTDIR\src"
  RMDir /r "$INSTDIR\dist"
  Delete "$INSTDIR\package.json"
  Delete "$INSTDIR\tsconfig.json"
  Delete "$INSTDIR\.env.example"
  Delete "$INSTDIR\AutoCut.cmd"
  Delete "$INSTDIR\LEIA-ME.txt"
  Delete "$INSTDIR\README.md"
  Delete "$INSTDIR\autocut.ico"
  Delete "$INSTDIR\ensure-browser.cjs"

  ; /SD IDNO: na desinstalação silenciosa, mantém os dados do usuário.
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Apagar também as configurações (chaves de API), os estilos e os arquivos de trabalho?$\r$\n$\r$\nA pasta de vídeos nunca é apagada." /SD IDNO IDNO keep
    Delete "$INSTDIR\.env"
    RMDir /r "$INSTDIR\estilos"
    RMDir /r "$INSTDIR\work"
  keep:

  Delete "$INSTDIR\Desinstalar.exe"
  ; Só remove a pasta se ficou vazia (os vídeos do usuário ficam).
  RMDir "$INSTDIR\videos\musicas"
  RMDir "$INSTDIR\videos"
  RMDir "$INSTDIR"

  RMDir /r "$SMPROGRAMS\AutoCut"
  Delete "$DESKTOP\AutoCut.lnk"
  DeleteRegKey HKCU "${UNINSTKEY}"
  DeleteRegKey HKCU "Software\AutoCut"
SectionEnd
