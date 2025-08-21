# Changelog

## [1.2.0] - 2025-08-21
### Added
- Carmelia icon

## [1.1.3] - 2025-08-21
### Fixed
- Body com tipo inline no parâmetro `@Body()` agora é corretamente inferido (ex.: `@Body() body: { input: string }`).
- Arrays genéricos `Array<T>`/`ReadonlyArray<T>` geram `[ exemploDeT ]` em vez de placeholder.
- Resolução de tipos importados a partir de caminhos absolutos do workspace (ex.: `src/...`).
- Suporte a `type` alias (ex.: `export type AgentCompanyInfo = { ... }`), expandindo corretamente para JSON.

### Enhanced
- Resolução recursiva de tipos referenciados (interfaces, classes e type aliases) com prevenção de ciclos.
- Exemplo de body mais fiel para objetos aninhados e arrays de objetos.
- Logs melhorados para auxiliar debug da geração do body.

### Docs
- README atualizado explicando suporte a tipos inline, arrays genéricos, imports absolutos e type aliases.

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
- **⚙️ Interface de Configurações**: Nova tela de configurações acessível via Command Palette
- **🔧 Botão Resetar Rota**: Reset instantâneo para aplicar configurações globais atuais à rota

### Enhanced
- **Busca Melhorada**: Resolução automática de imports relativos (ex: `./dto/user.dto.ts`)
- **Regex Avançada**: Detecção mais precisa de tipos exportados (`export class`, `export interface`)
- **Inferência por Nome**: Valores exemplo inteligentes baseados no nome da propriedade (`email` → "user@example.com")
- **🎨 Layout de Presets**: Melhorada responsividade e proporções da área de presets
- **📱 Interface Responsiva**: Corrigido problema de botões sendo cortados ou saindo da área visível
- **🔧 Usabilidade**: Select de preset agora possui tamanho adequado para melhor experiência do usuário

### Fixed
- **🔄 Substituição de Parâmetros**: Corrigida substituição de path parameters no comando cURL gerado
- **📋 Configurações Funcionais**: Base URL, Default Headers e Global Prefix agora funcionam corretamente

### Technical
- Função `generateBodyExample()` com busca em múltiplas etapas
- Análise AST melhorada para interfaces e classes TypeScript
- Suporte para tipos complexos (union types, objetos aninhados, arrays tipados)
- Sistema de cache para otimizar busca de tipos no workspace
- Movida função `replacePathParams` para escopo global do JavaScript da webview
- Corrigidas referências de template strings para variáveis JavaScript adequadas
- Melhorado gerenciamento de escopo de funções na webview
- Comando `nestCaller.openSettings` para acesso às configurações globais
- Sistema de mensagens para reset em tempo real das configurações
- Interface de configurações com salvamento no workspace do VS Code
- Ajustadas proporções do grid layout nos presets (labels: 80px, inputs: 2fr)
- Adicionadas larguras mínimas para botões e campos de entrada
- Melhorado layout flexbox para evitar overflow em diferentes tamanhos de tela

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
