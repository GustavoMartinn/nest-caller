# Nest Caller

Chame rotas **NestJS** direto do VS Code: clique no CodeLens acima do método decorado e preencha o formulário no Webview (params, headers, body, bearer). Pré-visualize e **copie cURL**, aplique **global prefix**, salve **presets** e exporte `.http`.

<p align="center">
  <img src="media/icon.png" width="128" height="128" alt="Nest Caller icon">
</p>

✨ Features
- CodeLens "Call …" em `@Get/@Post/@Put/@Patch/@Delete/@Head/@Options/@All`
- Lê `@Controller('prefix')` e compõe o path final
- Detecta `app.setGlobalPrefix('v1', { exclude: [...] })` (auto) e permite **toggle** no formulário
- **🎯 Body Pré-pronto**: Gera JSON automaticamente baseado no tipo do `@Body` (DTOs)
- **🔍 Busca Inteligente**: Encontra DTOs em arquivos separados via imports e workspace
- **🔄 Regeneração**: Botão para regenerar exemplo do body a qualquer momento
- **Query Params como chips removíveis**
- **Pré-visualizar cURL** e **Copiar cURL** para o clipboard
- **Headers padrão** (config) + Bearer Token opcional
- **Body JSON** (com validação)
- **Exportar .http** (compatível com a extensão REST Client)
- **Presets por rota** (último + nomeados)
- UI **theme-aware** (segue seu tema do VS Code) e responsiva

## 🧰 Requisitos
- VS Code 1.84+
- Projeto com arquivos TypeScript (controladores do Nest)

## ⚙️ Configurações
| Chave | Tipo | Default | Descrição |
|------|------|---------|-----------|
| `nestCaller.baseUrl` | string | `http://localhost:3000` | Base URL da sua API |
| `nestCaller.defaultHeaders` | string[] | `["Content-Type: application/json"]` | Headers padrão, um por linha |
| `nestCaller.globalPrefix` | string | `""` | Global prefix manual (se vazio, tentativa de detecção do `main.ts`) |

## 🚀 Uso
1. Abra um arquivo `.ts` de um **controller Nest**.
2. Clique no CodeLens **“Call …”** acima do método.
3. No Webview, ajuste path params, query params, headers/body.
4. (Opcional) Ative **Apply Global Prefix**.
5. **Pré-visualize** ou **Copie** o cURL, ou **Send** para executar pelo terminal.
6. **Export .http** se quiser salvar a requisição.

## 🧪 Desenvolvimento
```bash
npm i
npm run watch   # recompila em tempo real
# F5 -> "Run Extension" (abre a janela Extension Development Host)
```

## 📦 Empacotar / Publicar
```bash
# gerar .vsix
npm run package

# publicar no Marketplace
npx vsce login <publisher>
npx vsce publish
```

## 📝 Licença
MIT — veja [LICENSE](./LICENSE).
# nest-caller
