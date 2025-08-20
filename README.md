# Nest Caller

Chame rotas **NestJS** direto do VS Code: clique no CodeLens acima do método decorado e preencha o formulário no Webview (params, headers, body, bearer). Pré-visualize e **copie cURL**, aplique **global prefix**, salve **presets** e exporte `.http`.

<p align="center">
  <img src="media/icon.png" width="128" height="128" alt="Nest Caller icon">
</p>

## 🚀 Uso

### Configuração Inicial
1. **Configure a extensão**: `Ctrl+Shift+P` → "Nest Caller: Open Settings"
   - Defina **Base URL** (ex: `http://localhost:3000`)
   - Configure **Default Headers** (ex: `Content-Type: application/json`)
   - Defina **Global Prefix** se necessário (ex: `/v1`)

### Fazendo Requests
1. Abra um arquivo `.ts` de um **controller Nest**
2. Clique no CodeLens **"Call …"** acima do método decorado
3. **Body é gerado automaticamente** se o método usar `@Body` com DTO
4. Ajuste **path params**, **query params**, **headers** conforme necessário
5. Use **"Resetar Rota"** se quiser aplicar configurações globais atuais
6. **Pré-visualize cURL**, **Copie** ou **Send** para executar
7. **Salve como preset** para reutilizar configurações

### Funcionalidades Avançadas
- **Regenerar Body**: Use o botão para recriar exemplo baseado no DTO
- **Presets**: Salve configurações frequentes por rota
- **Export .http**: Exporte para usar com REST Client extension
- **Global Prefix**: Toggle automático baseado em detecção do `main.ts`

## 🎯 Suporte a DTOs

A extensão detecta automaticamente tipos TypeScript para gerar exemplos de body:

### ✅ Tipos Suportados
- **Interfaces**: `interface CreateUserDto { name: string; age: number; }`
- **Classes**: `class UpdateUserDto { email?: string; }`
- **Tipos Primitivos**: `string`, `number`, `boolean`, `Date`
- **Arrays**: `string[]`, `UserDto[]`
- **Objetos Aninhados**: `{ address: { street: string; city: string; } }`
- **Union Types**: `'admin' | 'user'`
- **Propriedades Opcionais**: `email?: string`

### 🔍 Busca Inteligente
- **Mesmo Arquivo**: DTOs definidos no arquivo do controller
- **Imports Relativos**: `import { UserDto } from './dto/user.dto'`
- **Busca no Workspace**: Encontra DTOs em qualquer arquivo do projeto
- **Fallback Inteligente**: Gera exemplos baseados no nome quando DTO não é encontrado

### 💡 Exemplos Gerados
```typescript
// DTO
interface CreateProductDto {
  name: string;
  price: number;
  isAvailable: boolean;
  tags: string[];
}
```

// JSON Gerado
``` JSON
{
  "name": "example_string",
  "price": 42,
  "isAvailable": true,
  "tags": ["example_string"]
}
```

## 🔧 Interface & Configurações
- **Interface de Configurações**: Acesse via Command Palette (`Ctrl+Shift+P` → "Nest Caller: Open Settings")
- **Botão Resetar Rota**: Reset instantâneo para aplicar configurações globais à rota atual
- **Layout Responsivo**: Interface otimizada para diferentes tamanhos de tela
- **Theme-aware**: Segue automaticamente o tema do VS Code

## ✨ Features
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
- Detecta `app.setGlobalPrefix('v1', { exclude: [...] })` automaticamente
- **Path Parameters**: Detecção automática via `@Param()` com substituição em tempo real
- **Query Params**: Interface com chips removíveis para fácil gerenciamento
- **Headers**: Configuração padrão + Bearer Token opcional
- **Body JSON**: Validação automática + exemplos baseados em DTOs

### 🛠️ Ferramentas & Export
- **Pré-visualizar cURL**: Visualização em tempo real do comando
- **Copiar cURL**: Um clique para copiar para clipboard
- **Exportar .http**: Compatível com REST Client extension
- **Presets por Rota**: Salve configurações (último usado + nomeados)
- **Execução Direta**: Send via terminal integrado

## 🧰 Requisitos
- VS Code 1.84+
- Projeto com arquivos TypeScript (controladores do Nest)

## ⚙️ Configurações
| Chave | Tipo | Default | Descrição |
|------|------|---------|-----------|
| `nestCaller.baseUrl` | string | `http://localhost:3000` | Base URL da sua API |
| `nestCaller.defaultHeaders` | string[] | `["Content-Type: application/json"]` | Headers padrão, um por linha |
| `nestCaller.globalPrefix` | string | `""` | Global prefix manual (se vazio, tentativa de detecção do `main.ts`) |


## 📋 Comandos
| Comando | Descrição |
|---------|-----------|
| `Nest Caller: Open Route Form` | Abre formulário para uma rota específica |
| `Nest Caller: Open Settings` | Abre interface de configurações globais |

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
