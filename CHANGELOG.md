# Changelog

Todas as mudanças notáveis neste projeto serão documentadas aqui.

## [1.1.0] - 2025-08-19
### Added
- **🎯 Body Pré-pronto baseado em DTOs**: Geração automática de JSON de exemplo quando métodos possuem `@Body` com tipos específicos
- **🔍 Detecção Inteligente de Tipos**: Captura automática do tipo do parâmetro `@Body` (interfaces, classes e tipos personalizados)
- **🧠 Geração Contextual**: Cria exemplos realistas baseados na estrutura do DTO (primitivos, arrays, objetos aninhados)
- **📁 Busca Multi-arquivo**: Encontra DTOs em arquivos separados via análise de imports e busca no workspace
- **🔄 Regeneração Manual**: Botão para regenerar o exemplo do body a qualquer momento
- **📝 Indicação Visual**: Mostra qual DTO foi usado como base (ex: "baseado em CreateUserDto")
- **🎲 Fallbacks Inteligentes**: Exemplos genéricos baseados em padrões de nomenclatura quando DTO não é encontrado
- **🔍 Logs Detalhados**: Console logs para debug do processo de geração de exemplos

### Enhanced
- **Busca Melhorada**: Resolução automática de imports relativos (ex: `./dto/user.dto.ts`)
- **Regex Avançada**: Detecção mais precisa de tipos exportados (`export class`, `export interface`)
- **Inferência por Nome**: Valores exemplo inteligentes baseados no nome da propriedade (`email` → "user@example.com")

### Technical
- Função `generateBodyExample()` com busca em múltiplas etapas
- Análise AST melhorada para interfaces e classes TypeScript
- Suporte para tipos complexos (union types, objetos aninhados, arrays tipados)
- Sistema de cache para otimizar busca de tipos no workspace

## [1.0.0] - 2025-08-18
### Added
- CodeLens “Call …” sobre métodos `@Get/@Post/@Put/@Patch/@Delete/...` do Nest.
- Detecção de `@Controller()` e composição automática do path.
- Detecção de `setGlobalPrefix()` com opção de aplicar prefixo global.
- Formulário de chamada com Path Params, Query Params (chips removíveis), Headers e Body JSON.
- Bearer token opcional com `Authorization: Bearer <token>`.
- Prévia e **copiar cURL** (clipboard) direto no Webview.
- Exportar requisição como arquivo `.http` (REST Client).
- Presets salvos por rota (último usado + nomeados).
- UI responsiva e theme-aware (tokens do VS Code).
