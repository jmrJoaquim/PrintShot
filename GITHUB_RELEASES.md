# Publicar o PrintShot e ativar atualizações

O workflow `.github/workflows/release.yml` cria um Release do Windows quando uma tag `v*` é enviada. O instalador, `latest.yml` e os arquivos auxiliares são publicados pelo `electron-builder`. O app instalado verifica atualizações na inicialização e, depois de baixar uma, oferece reiniciar para instalá-la.

## Primeira publicação

1. Crie no GitHub um repositório **público** chamado `PrintShot`.
2. No PowerShell, dentro desta pasta do projeto, conecte o repositório recém-criado:

   ```powershell
   git remote add origin https://github.com/SEU_USUARIO/PrintShot.git
   git branch -M main
   git add .
   git commit -m "Preparar PrintShot 2.0.1"
   git push -u origin main
   ```

3. Publique a primeira versão que contém o atualizador:

   ```powershell
   git tag v2.0.1
   git push origin v2.0.1
   ```

4. Abra a aba **Actions** do repositório e aguarde o workflow terminar. O instalador estará na aba **Releases**.
5. Instale manualmente o instalador 2.0.1. A versão 2.0.0 já instalada não tem o código do atualizador e, portanto, não consegue se atualizar sozinha.

O workflow usa o token temporário `GITHUB_TOKEN` do próprio GitHub Actions; não crie nem envie um token pessoal ao repositório.

## Próximas versões

Atualize a versão em `package.json`, confira o termo com `npm run sync:terms-version`, salve as alterações e envie uma tag que corresponda à versão. Por exemplo, para a versão `2.0.2`:

```powershell
npm run sync:terms-version
git add package.json package-lock.json TERMO_DE_RESPONSABILIDADE.md
git commit -m "Preparar PrintShot 2.0.2"
git tag v2.0.2
git push origin main
git push origin v2.0.2
```

As cópias instaladas verificam a atualização ao iniciar o PrintShot e periodicamente enquanto ele estiver aberto. A atualização baixada é aplicada quando o usuário escolhe reiniciar, ou ao fechar o app.

## Importante sobre assinatura

O instalador atual não possui certificado de assinatura. O GitHub Releases distribui os arquivos, mas não remove os avisos de segurança que o Windows pode mostrar para aplicativos sem assinatura. Para reduzir esses avisos, será necessário obter um certificado de assinatura de código e configurá-lo como um segredo do repositório.
