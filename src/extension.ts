import * as vscode from 'vscode';
import * as ts from 'typescript';

/** -------------------- Tipos -------------------- */
type GlobalPrefix = { prefix: string; excludes: string[] };

type RouteInfo = {
  method: string;               // GET/POST/...
  path: string;                 // path já com @Controller + método
  line: number;
  controllerMethodName: string;
  controllerPrefix?: string;
  params: {
    pathParams: string[];
    queryParams: string[];      // nomes de @Query('x'); '*' se livre
    hasBody: boolean;
    bodyType?: string;          // tipo do @Body (ex: CreateUserDto)
    bodyExample?: string;       // JSON de exemplo baseado no tipo
  };
};

type PresetPayload = {
  baseUrl: string;
  path: string;
  pathParams: Record<string, string>;
  query: Record<string, string>;
  headers: string[];            // "Key: Value"
  bearerToken?: string;
  includeBearer?: boolean;
  bodyText?: string;
  applyGlobal?: boolean;
  globalPrefix?: string;
};

type RoutePresets = {
  last?: PresetPayload;
  named?: Record<string, PresetPayload>;
};

const GLOBAL_KEY = 'nestCaller.presets';
const HTTP_DECOS = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete', 'Options', 'Head', 'All']);

/** -------------------- Ativação -------------------- */
export function activate(context: vscode.ExtensionContext) {
  const provider: vscode.CodeLensProvider = {
    async provideCodeLenses(document) {
      if (!document.fileName.endsWith('.ts')) return [];
      try {
        const routes = await extractRoutes(document);
        return routes.map(r => {
          const range = new vscode.Range(r.line, 0, r.line, 0);
          return new vscode.CodeLens(range, {
            title: `Call ${r.method} ${r.path}`,
            command: 'nestCaller.openRouteForm',
            arguments: [r]
          });
        });
      } catch {
        return [];
      }
    }
  };

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      [{ language: 'typescript', scheme: 'file' }],
      provider
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('nestCaller.openRouteForm',
      async (route: RouteInfo) => openFormWebview(route, context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('nestCaller.openSettings',
      async () => openSettingsWebview(context))
  );
}

export function deactivate() { }

/** -------------------- Extração de rotas -------------------- */
async function extractRoutes(document: vscode.TextDocument): Promise<RouteInfo[]> {
  const source = ts.createSourceFile(
    document.fileName,
    document.getText(),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  const routesData: Omit<RouteInfo, 'params'>[] = [];
  const paramsData: Array<{
    pathParams: string[];
    queryParams: string[];
    hasBody: boolean;
    bodyType?: string;
  }> = [];

  const visit = (node: ts.Node) => {
    if (
      ts.isMethodDeclaration(node) &&
      ts.canHaveDecorators(node) &&
      ts.getDecorators(node) &&
      node.parent &&
      ts.isClassDeclaration(node.parent)
    ) {
      const controllerPrefix = getControllerPrefix(node.parent);

      const decorators = ts.getDecorators(node) || [];
      const httpDeco = decorators.find(d => {
        const expr = d.expression;
        return ts.isCallExpression(expr) &&
          ts.isIdentifier(expr.expression) &&
          HTTP_DECOS.has(expr.expression.text);
      });

      if (httpDeco) {
        const call = httpDeco.expression as ts.CallExpression;
        const method = (call.expression as ts.Identifier).text.toUpperCase();

        // path do método
        let methodPath = '/';
        if (call.arguments.length > 0) {
          const arg = call.arguments[0];
          if (ts.isStringLiteralLike(arg)) methodPath = ensureLeadingSlash(arg.text);
        }

        // compõe controller + método
        const composedPath = joinPath(controllerPrefix || '', methodPath);

        // coleta params
        const paramsInfo = { pathParams: new Set<string>(), queryParams: new Set<string>(), hasBody: false, bodyType: undefined as string | undefined };
        for (const m of composedPath.matchAll(/:([A-Za-z0-9_]+)/g)) paramsInfo.pathParams.add(m[1]);

        node.parameters.forEach(p => {
          if (!ts.canHaveDecorators(p)) return;
          const decorators = ts.getDecorators(p) || [];
          decorators.forEach(d => {
            if (!ts.isCallExpression(d.expression)) return;
            const decoId = d.expression.expression;
            const decoName = ts.isIdentifier(decoId) ? decoId.text : '';

            if (decoName === 'Param') {
              const name = readFirstStringArg(d.expression.arguments) ?? 'id';
              paramsInfo.pathParams.add(name);
            } else if (decoName === 'Query') {
              const name = readFirstStringArg(d.expression.arguments);
              if (name) paramsInfo.queryParams.add(name);
              else paramsInfo.queryParams.add('*');
            } else if (decoName === 'Body') {
              paramsInfo.hasBody = true;
              // Captura o tipo do parâmetro @Body
              if (p.type) {
                paramsInfo.bodyType = getTypeNameFromTypeNode(p.type);
              }
            }
          });
        });

        const methodName = node.name && ts.isIdentifier(node.name) ? node.name.text : 'handler';
        const line = document.positionAt(node.getStart()).line;

        routesData.push({
          method,
          path: composedPath,
          controllerPrefix,
          line,
          controllerMethodName: methodName
        });

        paramsData.push({
          pathParams: Array.from(paramsInfo.pathParams),
          queryParams: Array.from(paramsInfo.queryParams),
          hasBody: paramsInfo.hasBody,
          bodyType: paramsInfo.bodyType
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);

  // Agora processa os exemplos de body de forma assíncrona
  const routes: RouteInfo[] = [];
  for (let i = 0; i < routesData.length; i++) {
    const routeData = routesData[i];
    const params = paramsData[i];

    let bodyExample: string | undefined;
    if (params.hasBody && params.bodyType) {
      bodyExample = await generateBodyExample(params.bodyType, document);
    }

    routes.push({
      ...routeData,
      params: {
        ...params,
        bodyExample
      }
    });
  }

  return routes;
}

function getControllerPrefix(cls: ts.ClassDeclaration): string {
  const decorators = ts.canHaveDecorators(cls) ? ts.getDecorators(cls) ?? [] : [];
  for (const d of decorators) {
    const expr = d.expression;
    if (ts.isCallExpression(expr)) {
      const id = expr.expression;
      if (ts.isIdentifier(id) && id.text === 'Controller') {
        const arg = expr.arguments?.[0];
        if (arg && ts.isStringLiteralLike(arg)) return ensureLeadingSlash(arg.text);
        if (arg && ts.isObjectLiteralExpression(arg)) {
          const pathProp = arg.properties.find(p =>
            ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'path'
          ) as ts.PropertyAssignment | undefined;
          if (pathProp && ts.isStringLiteralLike(pathProp.initializer)) {
            return ensureLeadingSlash(pathProp.initializer.text);
          }
        }
      }
    }
  }
  return '';
}

function readFirstStringArg(args: readonly ts.Expression[]): string | undefined {
  if (!args || !args.length) return undefined;
  const a = args[0];
  if (ts.isStringLiteralLike(a)) return a.text;
  return undefined;
}

function getTypeNameFromTypeNode(typeNode: ts.TypeNode): string | undefined {
  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
    return typeNode.typeName.text;
  }
  if (ts.isIdentifier(typeNode)) {
    return typeNode.text;
  }
  return undefined;
}

async function generateBodyExample(bodyType: string, document: vscode.TextDocument): Promise<string | undefined> {
  if (!bodyType) {
    console.log(`[NestCaller] bodyType vazio`);
    return undefined;
  }

  console.log(`[NestCaller] Gerando exemplo para tipo: ${bodyType}`);

  try {
    // Busca por definições do tipo no arquivo atual ou no workspace
    const source = ts.createSourceFile(
      document.fileName,
      document.getText(),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );

    console.log(`[NestCaller] Arquivo analisado: ${document.fileName}`);

    // Primeira tentativa: no arquivo atual
    const typeDefinition = findTypeDefinition(source, bodyType);
    if (typeDefinition) {
      const example = generateJSONFromInterface(typeDefinition);
      console.log(`[NestCaller] Gerado exemplo para ${bodyType}:`, example);
      return example;
    }

    console.log(`[NestCaller] Tipo ${bodyType} não encontrado no arquivo atual`);

    // Segunda tentativa: seguir imports do arquivo atual
    const importExample = await searchTypeInImports(source, bodyType, document);
    if (importExample) {
      console.log(`[NestCaller] Tipo ${bodyType} encontrado via imports:`, importExample);
      return importExample;
    }

    console.log(`[NestCaller] Tipo ${bodyType} não encontrado nos imports, buscando no workspace...`);

    // Terceira tentativa: busca no workspace
    const workspaceExample = await searchTypeInWorkspace(bodyType);
    if (workspaceExample) {
      console.log(`[NestCaller] Encontrado ${bodyType} no workspace:`, workspaceExample);
      return workspaceExample;
    }

    console.log(`[NestCaller] Tipo ${bodyType} não encontrado no workspace, usando exemplo genérico`);
    // Se não encontrou, retorna um exemplo genérico baseado no nome
    const genericExample = generateGenericExample(bodyType);
    console.log(`[NestCaller] Exemplo genérico para ${bodyType}:`, genericExample);
    return genericExample;
  } catch (error) {
    console.log(`[NestCaller] Erro ao gerar exemplo para ${bodyType}:`, error);
    // Se der erro, tenta pelo menos o exemplo genérico
    try {
      return generateGenericExample(bodyType);
    } catch {
      return undefined;
    }
  }
}

async function searchTypeInImports(source: ts.SourceFile, typeName: string, document: vscode.TextDocument): Promise<string | undefined> {
  console.log(`[NestCaller] Analisando imports para encontrar ${typeName}`);

  // Busca por import statements que podem conter o tipo
  const imports: { modulePath: string; importedNames: string[] }[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const modulePath = node.moduleSpecifier.text;
      const importedNames: string[] = [];

      if (node.importClause) {
        if (node.importClause.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
          for (const element of node.importClause.namedBindings.elements) {
            importedNames.push(element.name.text);
          }
        }

        // Default import
        if (node.importClause.name) {
          importedNames.push(node.importClause.name.text);
        }
      }

      if (importedNames.includes(typeName)) {
        imports.push({ modulePath, importedNames });
        console.log(`[NestCaller] Tipo ${typeName} encontrado no import de: ${modulePath}`);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);

  // Para cada import que contém o tipo, tenta resolver o arquivo
  for (const imp of imports) {
    try {
      const resolvedPath = resolveImportPath(imp.modulePath, document.fileName);
      if (resolvedPath) {
        console.log(`[NestCaller] Tentando ler arquivo resolvido: ${resolvedPath}`);

        const uri = vscode.Uri.file(resolvedPath);
        const content = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(content).toString('utf8');

        const importedSource = ts.createSourceFile(resolvedPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        const typeDefinition = findTypeDefinition(importedSource, typeName);

        if (typeDefinition) {
          console.log(`[NestCaller] Tipo ${typeName} encontrado e processado de ${resolvedPath}`);
          return generateJSONFromInterface(typeDefinition);
        }
      }
    } catch (error) {
      console.log(`[NestCaller] Erro ao processar import ${imp.modulePath}:`, error);
      continue;
    }
  }

  return undefined;
}

function resolveImportPath(importPath: string, currentFilePath: string): string | undefined {
  try {
    const path = require('path');
    const fs = require('fs');

    // Se é um import relativo
    if (importPath.startsWith('./') || importPath.startsWith('../')) {
      const currentDir = path.dirname(currentFilePath);
      let resolvedPath = path.resolve(currentDir, importPath);

      // Tenta diferentes extensões
      const extensions = ['.ts', '.tsx', '.js', '.jsx'];

      for (const ext of extensions) {
        const fullPath = resolvedPath + ext;
        if (fs.existsSync(fullPath)) {
          return fullPath;
        }
      }

      // Tenta como diretório com index
      for (const ext of extensions) {
        const indexPath = path.join(resolvedPath, 'index' + ext);
        if (fs.existsSync(indexPath)) {
          return indexPath;
        }
      }
    }

    // Para imports absolutos ou de node_modules, não tentamos resolver por agora
    return undefined;
  } catch (error) {
    console.log(`[NestCaller] Erro ao resolver caminho do import ${importPath}:`, error);
    return undefined;
  }
}

function generateGenericExample(typeName: string): string {
  // Gera exemplos genéricos baseados em padrões comuns de nomes
  const lowerName = typeName.toLowerCase();

  if (lowerName.includes('user')) {
    return JSON.stringify({
      name: "João Silva",
      email: "joao@example.com",
      age: 30
    }, null, 2);
  }

  if (lowerName.includes('product')) {
    return JSON.stringify({
      name: "Produto Exemplo",
      price: 99.99,
      description: "Descrição do produto"
    }, null, 2);
  }

  if (lowerName.includes('create') || lowerName.includes('post')) {
    return JSON.stringify({
      name: "string",
      description: "string"
    }, null, 2);
  }

  if (lowerName.includes('update') || lowerName.includes('put') || lowerName.includes('patch')) {
    return JSON.stringify({
      name: "string"
    }, null, 2);
  }

  // Exemplo genérico
  return JSON.stringify({
    field1: "string",
    field2: 0,
    field3: false
  }, null, 2);
}

function findTypeDefinition(source: ts.SourceFile, typeName: string): ts.InterfaceDeclaration | ts.ClassDeclaration | undefined {
  let found: ts.InterfaceDeclaration | ts.ClassDeclaration | undefined;

  const visit = (node: ts.Node) => {
    // Busca por interfaces
    if (ts.isInterfaceDeclaration(node)) {
      if (node.name && ts.isIdentifier(node.name) && node.name.text === typeName) {
        console.log(`[NestCaller] Interface ${typeName} encontrada`);
        found = node;
        return;
      }
    }

    // Busca por classes
    if (ts.isClassDeclaration(node)) {
      if (node.name && ts.isIdentifier(node.name) && node.name.text === typeName) {
        console.log(`[NestCaller] Classe ${typeName} encontrada`);
        found = node;
        return;
      }
    }

    // Busca por tipos exportados
    if (ts.isModuleDeclaration(node)) {
      ts.forEachChild(node, visit);
      return;
    }

    // Busca dentro de export statements
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      // Não é o que precisamos aqui, mas pode ser útil em casos específicos
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  if (!found) {
    console.log(`[NestCaller] Tipo ${typeName} não encontrado na árvore AST`);
  }

  return found;
}

function generateJSONFromInterface(node: ts.InterfaceDeclaration | ts.ClassDeclaration): string {
  const properties: Record<string, any> = {};

  const members = ts.isInterfaceDeclaration(node) ? node.members :
    ts.isClassDeclaration(node) ? node.members.filter(ts.isPropertyDeclaration) : [];

  console.log(`[NestCaller] Processando ${members.length} membros do tipo`);

  for (const member of members) {
    if (ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)) {
      const name = member.name && ts.isIdentifier(member.name) ? member.name.text : 'unknown';
      const type = member.type;

      console.log(`[NestCaller] Processando propriedade: ${name}`);

      if (type) {
        properties[name] = getExampleValueForType(type);
        console.log(`[NestCaller] Tipo processado para ${name}:`, properties[name]);
      } else {
        // Se não tem tipo explícito, tenta inferir pelo nome
        properties[name] = inferValueByPropertyName(name);
        console.log(`[NestCaller] Valor inferido para ${name}:`, properties[name]);
      }
    }
  }

  const result = JSON.stringify(properties, null, 2);
  console.log(`[NestCaller] JSON final gerado:`, result);
  return result;
}

function inferValueByPropertyName(propName: string): any {
  const lowerName = propName.toLowerCase();

  // Inferência baseada no nome da propriedade
  if (lowerName.includes('email')) return "user@example.com";
  if (lowerName.includes('name')) return "Example Name";
  if (lowerName.includes('id')) return "12345";
  if (lowerName.includes('age')) return 25;
  if (lowerName.includes('date') || lowerName.includes('time')) return new Date().toISOString();
  if (lowerName.includes('active') || lowerName.includes('enabled')) return true;
  if (lowerName.includes('count') || lowerName.includes('number')) return 0;
  if (lowerName.includes('list') || lowerName.includes('array') || lowerName.includes('tags')) return [];
  if (lowerName.includes('address') || lowerName.includes('info') || lowerName.includes('data')) return {};

  return "example_value";
}

function getExampleValueForType(typeNode: ts.TypeNode): any {
  // Verifica se é um tipo primitivo pelo kind
  switch (typeNode.kind) {
    case ts.SyntaxKind.StringKeyword:
      return "example_string";
    case ts.SyntaxKind.NumberKeyword:
      return 42;
    case ts.SyntaxKind.BooleanKeyword:
      return true;
    case ts.SyntaxKind.AnyKeyword:
      return null;
    case ts.SyntaxKind.VoidKeyword:
      return null;
    case ts.SyntaxKind.UndefinedKeyword:
      return undefined;
    case ts.SyntaxKind.NullKeyword:
      return null;
  }

  if (ts.isArrayTypeNode(typeNode)) {
    return [getExampleValueForType(typeNode.elementType)];
  }

  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
    const typeName = typeNode.typeName.text;
    // Tipos comuns
    if (typeName === 'Date') return new Date().toISOString();
    if (typeName === 'String') return "example_string";
    if (typeName === 'Number') return 42;
    if (typeName === 'Boolean') return true;

    // Para outros tipos personalizados, retorna um objeto com placeholder
    return { [typeName.toLowerCase()]: "nested_object" };
  }

  if (ts.isUnionTypeNode(typeNode)) {
    // Para union types, pega o primeiro tipo
    return getExampleValueForType(typeNode.types[0]);
  }

  if (ts.isTypeLiteralNode(typeNode)) {
    // Para tipos literais de objeto, processa as propriedades
    const obj: Record<string, any> = {};
    for (const member of typeNode.members) {
      if (ts.isPropertySignature(member) && member.name && ts.isIdentifier(member.name)) {
        const propName = member.name.text;
        const propType = member.type;
        if (propType) {
          obj[propName] = getExampleValueForType(propType);
        } else {
          obj[propName] = "unknown_type";
        }
      }
    }
    return obj;
  }

  return "unknown_type";
}

async function searchTypeInWorkspace(typeName: string): Promise<string | undefined> {
  try {
    console.log(`[NestCaller] Buscando ${typeName} no workspace...`);

    // Busca por arquivos TypeScript (mais ampla)
    const files = await vscode.workspace.findFiles('**/*.ts', '**/node_modules/**', 50);
    console.log(`[NestCaller] Encontrados ${files.length} arquivos .ts no workspace`);

    for (const file of files) {
      try {
        const content = await vscode.workspace.fs.readFile(file);
        const text = Buffer.from(content).toString('utf8');

        // Busca mais precisa usando regex
        const classRegex = new RegExp(`\\bclass\\s+${typeName}\\b`, 'g');
        const interfaceRegex = new RegExp(`\\binterface\\s+${typeName}\\b`, 'g');
        const typeRegex = new RegExp(`\\btype\\s+${typeName}\\b`, 'g');
        const exportClassRegex = new RegExp(`\\bexport\\s+class\\s+${typeName}\\b`, 'g');
        const exportInterfaceRegex = new RegExp(`\\bexport\\s+interface\\s+${typeName}\\b`, 'g');

        if (classRegex.test(text) || interfaceRegex.test(text) || typeRegex.test(text) ||
          exportClassRegex.test(text) || exportInterfaceRegex.test(text)) {

          console.log(`[NestCaller] Tipo ${typeName} encontrado em: ${file.fsPath}`);

          const source = ts.createSourceFile(file.fsPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
          const typeDefinition = findTypeDefinition(source, typeName);

          if (typeDefinition) {
            const result = generateJSONFromInterface(typeDefinition);
            console.log(`[NestCaller] Definição processada para ${typeName}:`, result);
            return result;
          } else {
            console.log(`[NestCaller] Regex encontrou ${typeName} em ${file.fsPath}, mas AST não conseguiu processar`);
          }
        }
      } catch (error) {
        console.log(`[NestCaller] Erro ao processar arquivo ${file.fsPath}:`, error);
        continue;
      }
    }

    console.log(`[NestCaller] Tipo ${typeName} não encontrado em nenhum arquivo do workspace`);
  } catch (error) {
    console.log(`[NestCaller] Erro na busca no workspace:`, error);
  }

  return undefined;
}

/** -------------------- Global prefix (detecção) -------------------- */
async function detectGlobalPrefix(): Promise<GlobalPrefix | null> {
  try {
    const files = await vscode.workspace.findFiles('**/main.ts', '**/node_modules/**', 2);
    if (!files.length) return null;
    const buf = await vscode.workspace.fs.readFile(files[0]);
    const text = Buffer.from(buf).toString('utf8');
    const sf = ts.createSourceFile(files[0].fsPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    let prefix = '';
    const excludes: string[] = [];

    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const prop = n.expression;
        if (ts.isIdentifier(prop.name) && prop.name.text === 'setGlobalPrefix') {
          const arg0 = n.arguments[0];
          if (arg0 && ts.isStringLiteralLike(arg0)) prefix = ensureLeadingSlash(arg0.text);

          const arg1 = n.arguments[1];
          if (arg1 && ts.isObjectLiteralExpression(arg1)) {
            const excl = arg1.properties.find(p =>
              ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'exclude'
            ) as ts.PropertyAssignment | undefined;

            if (excl && ts.isArrayLiteralExpression(excl.initializer)) {
              for (const el of excl.initializer.elements) {
                if (ts.isStringLiteralLike(el)) excludes.push(el.text);
                else if (ts.isObjectLiteralExpression(el)) {
                  const pProp = el.properties.find(pp =>
                    ts.isPropertyAssignment(pp) && ts.isIdentifier(pp.name) && pp.name.text === 'path'
                  ) as ts.PropertyAssignment | undefined;
                  if (pProp && ts.isStringLiteralLike(pProp.initializer)) {
                    excludes.push(pProp.initializer.text);
                  }
                }
              }
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);

    if (!prefix) return null;
    return { prefix, excludes };
  } catch {
    return null;
  }
}

function excludedByGlobalPrefix(fullPath: string, gp: GlobalPrefix): boolean {
  return gp.excludes.includes(fullPath) || gp.excludes.includes('/' + fullPath.replace(/^\/+/, ''));
}

/** -------------------- Webview + fluxo -------------------- */
async function openFormWebview(route: RouteInfo, context: vscode.ExtensionContext) {
  const baseUrl = vscode.workspace.getConfiguration('nestCaller').get<string>('baseUrl') || 'http://localhost:3000';
  const defaultHeaders = vscode.workspace.getConfiguration('nestCaller').get<string[]>('defaultHeaders') || ['Content-Type: application/json'];

  const cfgPrefix = vscode.workspace.getConfiguration('nestCaller').get<string>('globalPrefix') || '';
  const detected = await detectGlobalPrefix();
  const globalPrefix = cfgPrefix || detected?.prefix || '';

  const applyGlobalByDefault = globalPrefix
    ? !(detected && excludedByGlobalPrefix(route.path, detected))
    : false;

  const panel = vscode.window.createWebviewPanel(
    'nestCallerForm',
    `Call ${route.method} ${route.path}`,
    vscode.ViewColumn.Beside,
    { enableScripts: true }
  );

  const key = getRouteKey(route);
  const presets = getPresets(context)[key] ?? { named: {} };

  panel.webview.html = getWebviewHtmlWithGlobal(route, baseUrl, defaultHeaders, presets, {
    globalPrefix, applyGlobalByDefault
  });

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.type === 'submit' || msg.type === 'exportHttp') {
      const payload: PresetPayload = msg.payload;

      const prefixToUse = payload.applyGlobal && payload.globalPrefix ? payload.globalPrefix : '';
      const pathWithParams = replacePathParams(payload.path, payload.pathParams);
      const fullPath = joinPath(prefixToUse, pathWithParams);
      const qs = buildQueryString(payload.query || {});
      const url = joinUrl(payload.baseUrl, fullPath) + (qs ? `?${qs}` : '');

      const headers = normalizeHeaders(payload.headers || []);
      if (payload.includeBearer && payload.bearerToken && !headers.some(h => /^Authorization\s*:/i.test(h))) {
        headers.push(`Authorization: Bearer ${payload.bearerToken}`);
      }

      if (msg.type === 'submit') {
        let curl = `curl -i -X ${route.method} "${url}"`;
        headers.forEach(h => {
          curl += ` -H "${h.replace(/"/g, '\\"')}"`;
        });
        const hasBody = payload.bodyText && payload.bodyText.trim().length > 0 && route.method !== 'GET' && route.method !== 'HEAD';
        if (hasBody) curl += ` -d '${payload?.bodyText?.replace(/'/g, `'\\''`)}'`;
        const term = getOrCreateTerminal('nest-caller');
        term.show(true);
        term.sendText(curl);
      } else {
        const headerText = headers.join('\n');
        const bodyAllowed = !['GET', 'HEAD'].includes(route.method);
        const bodyText = (bodyAllowed && payload.bodyText && payload.bodyText.trim().length) ? payload.bodyText : '';
        const content =
          `### ${route.method} ${fullPath}
${route.method} ${url}
${headerText}

${bodyText}
`;
        const uri = await vscode.window.showSaveDialog({
          saveLabel: 'Salvar .http',
          filters: { 'REST Client': ['http'] },
          defaultUri: vscode.Uri.joinPath(
            vscode.workspace.workspaceFolders?.[0].uri ?? vscode.Uri.file(process.cwd()),
            `request_${route.method}_${sanitize(fullPath)}.http`
          )
        });
        if (uri) {
          await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
          vscode.window.showInformationMessage(`Arquivo salvo: ${uri.fsPath}`);
        }
      }

      const allNow = getPresets(context);
      const bucket = allNow[key] ?? { named: {} };
      bucket.last = payload;
      allNow[key] = bucket;
      await setPresets(context, allNow);
    }

    if (msg.type === 'savePreset') {
      const { name, data } = msg.payload as { name: string; data: PresetPayload };
      if (!name) return;
      const allNow = getPresets(context);
      const bucket = allNow[key] ?? { named: {} };
      bucket.named = bucket.named ?? {};
      bucket.named[name] = data;
      allNow[key] = bucket;
      await setPresets(context, allNow);
      panel.webview.postMessage({ type: 'presetList', payload: Object.keys(bucket.named) });
    }

    if (msg.type === 'deletePreset') {
      const { name } = msg.payload as { name: string };
      const allNow = getPresets(context);
      const bucket = allNow[key] ?? { named: {} };
      if (bucket?.named?.[name]) {
        delete bucket.named[name];
        allNow[key] = bucket;
        await setPresets(context, allNow);
        panel.webview.postMessage({ type: 'presetList', payload: Object.keys(bucket.named) });
      }
    }

    if (msg.type === 'requestPreset') {
      const { name } = msg.payload as { name: string };
      const allNow = getPresets(context);
      const bucket = allNow[key] ?? { named: {} };
      const data = bucket.named?.[name];
      if (data) panel.webview.postMessage({ type: 'presetData', payload: data });
    }

    if (msg.type === 'regenerateBody') {
      if (route.params.bodyType) {
        try {
          const currentDocument = vscode.window.activeTextEditor?.document;
          if (currentDocument) {
            const newExample = await generateBodyExample(route.params.bodyType, currentDocument);
            if (newExample) {
              panel.webview.postMessage({
                type: 'updateBody',
                payload: { bodyText: newExample }
              });
            } else {
              panel.webview.postMessage({
                type: 'showToast',
                payload: { message: 'Não foi possível regenerar o exemplo' }
              });
            }
          }
        } catch (error) {
          panel.webview.postMessage({
            type: 'showToast',
            payload: { message: 'Erro ao regenerar exemplo' }
          });
        }
      }
    }

    if (msg.type === 'resetToGlobalSettings') {
      // Busca as configurações globais atuais
      const currentConfig = vscode.workspace.getConfiguration('nestCaller');
      const currentBaseUrl = currentConfig.get<string>('baseUrl') || 'http://localhost:3000';
      const currentDefaultHeaders = currentConfig.get<string[]>('defaultHeaders') || ['Content-Type: application/json'];
      const currentGlobalPrefix = currentConfig.get<string>('globalPrefix') || '';

      // Detecta o global prefix atual
      const detected = await detectGlobalPrefix();
      const finalGlobalPrefix = currentGlobalPrefix || detected?.prefix || '';

      // Envia os valores atuais para a webview
      panel.webview.postMessage({
        type: 'applyGlobalReset',
        payload: {
          baseUrl: currentBaseUrl,
          headers: currentDefaultHeaders,
          globalPrefix: finalGlobalPrefix,
          bodyText: route.params.bodyExample || ''
        }
      });
    }
  });
}

/** -------------------- Settings Webview -------------------- */
async function openSettingsWebview(context: vscode.ExtensionContext) {
  const panel = vscode.window.createWebviewPanel(
    'nestCallerSettings',
    'Nest Caller - Configurações',
    vscode.ViewColumn.One,
    { enableScripts: true }
  );

  const currentConfig = vscode.workspace.getConfiguration('nestCaller');
  const baseUrl = currentConfig.get<string>('baseUrl') || 'http://localhost:3000';
  const defaultHeaders = currentConfig.get<string[]>('defaultHeaders') || ['Content-Type: application/json'];
  const globalPrefix = currentConfig.get<string>('globalPrefix') || '';

  panel.webview.html = getSettingsHtml({ baseUrl, defaultHeaders, globalPrefix });

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.type === 'saveSettings') {
      const { baseUrl, defaultHeaders, globalPrefix } = msg.payload;
      const config = vscode.workspace.getConfiguration('nestCaller');

      try {
        await config.update('baseUrl', baseUrl, vscode.ConfigurationTarget.Workspace);
        await config.update('defaultHeaders', defaultHeaders, vscode.ConfigurationTarget.Workspace);
        await config.update('globalPrefix', globalPrefix, vscode.ConfigurationTarget.Workspace);

        vscode.window.showInformationMessage('Configurações salvas com sucesso!');
        panel.dispose();
      } catch (error) {
        vscode.window.showErrorMessage('Erro ao salvar configurações: ' + error);
      }
    }
  });
}

/** -------------------- Helpers Node/VS Code -------------------- */
function getRouteKey(route: RouteInfo) { return `${route.method} ${route.path}`; }

function getPresets(context: vscode.ExtensionContext): Record<string, RoutePresets> {
  return context.globalState.get<Record<string, RoutePresets>>(GLOBAL_KEY) ?? {};
}
async function setPresets(context: vscode.ExtensionContext, value: Record<string, RoutePresets>) {
  await context.globalState.update(GLOBAL_KEY, value);
}

function getOrCreateTerminal(name: string): vscode.Terminal {
  const existing = vscode.window.terminals.find(t => t.name === name);
  return existing || vscode.window.createTerminal(name);
}

function ensureLeadingSlash(p: string) { if (!p) return '/'; return p.startsWith('/') ? p : `/${p}`; }
function joinPath(a: string, b: string) {
  if (!a) return ensureLeadingSlash(b);
  if (!b) return ensureLeadingSlash(a);
  const left = a.endsWith('/') ? a.slice(0, -1) : a;
  const right = b.startsWith('/') ? b : `/${b}`;
  return left + right;
}
function joinUrl(base: string, path: string) {
  if (base.endsWith('/') && path.startsWith('/')) return base.slice(0, -1) + path;
  if (!base.endsWith('/') && !path.startsWith('/')) return base + '/' + path;
  return base + path;
}
function buildQueryString(obj: Record<string, string>) {
  const parts: string[] = [];
  Object.entries(obj || {}).forEach(([k, v]) => {
    if (k && v !== undefined && v !== null && `${v}`.length) {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(`${v}`)}`);
    }
  });
  return parts.join('&');
}
function normalizeHeaders(items: string[]) {
  return items.map(s => s.trim()).filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i);
}
function sanitize(p: string) { return p.replace(/[^\w\-]+/g, '_'); }

function replacePathParams(path: string, pathParams: Record<string, string>): string {
  let result = path;
  Object.entries(pathParams || {}).forEach(([key, value]) => {
    // Substitui :param pelo valor
    result = result.replace(new RegExp(`:${key}\\b`, 'g'), value || `:${key}`);
  });
  return result;
}

/** -------------------- HTML da Webview (bonito + chips + copiar cURL) -------------------- */
function getWebviewHtmlWithGlobal(
  route: RouteInfo,
  baseUrl: string,
  defaultHeaders: string[],
  presets: RoutePresets,
  gp: { globalPrefix: string; applyGlobalByDefault: boolean }
) {
  const knownQuery = route.params.queryParams.filter(q => q !== '*');
  const presetNames = Object.keys(presets.named ?? {});
  const last = presets.last;

  const initial = JSON.stringify({
    baseUrl,
    path: route.path,
    pathParams: Object.fromEntries(route.params.pathParams.map(k => [k, ''])),
    query: Object.fromEntries(knownQuery.map(k => [k, ''])),
    headers: defaultHeaders,
    bearerToken: '',
    includeBearer: false,
    bodyText: route.params.bodyExample || '',
    applyGlobal: gp.applyGlobalByDefault,
    globalPrefix: gp.globalPrefix
  });

  const lastJSON = last ? JSON.stringify(last) : 'null';
  const namesJSON = JSON.stringify(presetNames);
  const knownQPJSON = JSON.stringify(knownQuery);
  const pathParamsJSON = JSON.stringify(route.params.pathParams);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<style>
  :root{
    --bg: var(--vscode-editor-background);
    --panel: var(--vscode-sideBar-background);
    --text: var(--vscode-foreground);
    --muted: var(--vscode-descriptionForeground);
    --border: var(--vscode-panel-border);
    --focus: var(--vscode-focusBorder);
    --btn-bg: var(--vscode-button-background);
    --btn-fg: var(--vscode-button-foreground);
    --btn-hover: var(--vscode-button-hoverBackground);
    --input-bg: var(--vscode-input-background);
    --input-fg: var(--vscode-input-foreground);
    --input-border: var(--vscode-input-border);
    --link: var(--vscode-textLink-foreground);
    --shadow: 0 1px 2px rgba(0,0,0,.06), 0 4px 12px rgba(0,0,0,.04);
    --radius: 10px;
    --gap: 14px;
    --chip-bg: rgba(127,127,127,.08);
  }

  /* base */
  *, *::before, *::after { box-sizing: border-box; }
  html, body {
    padding:0; margin:0;
    background:var(--bg); color:var(--text);
    font:13px/1.45 -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
  }
  .container { padding: 18px; max-width: 1400px; margin: 0 auto; }

  /* header */
  .header { display:flex; align-items:center; justify-content:space-between; margin-bottom: 16px; }
  .title { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .badge { font:11px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; border:1px solid var(--border); padding:4px 8px; border-radius:999px; text-transform:uppercase; letter-spacing:.6px; background:var(--panel); }
  .path-preview { font:12px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color:var(--muted); }

  /* UMA COLUNA para todos os cards (mesma largura de Preset/Global prefix) */
  .grid {
    display: grid;
    grid-template-columns: 1fr !important;
    gap: var(--gap);
  }

  /* cards/seções */
  .card {
    background:var(--panel); border:1px solid var(--border);
    border-radius:var(--radius); box-shadow:var(--shadow);
    padding:14px; min-width:0; /* evita overflow em grid */
  }
  .section {
    border:1px dashed var(--border);
    border-radius:calc(var(--radius) - 4px);
    padding:10px; margin-top:10px; min-width:0;
  }
  .section-title { font-weight:600; margin-bottom:8px; }

  /* linhas do formulário (coluna 2 pode encolher sem vazar) */
  .row {
    display:grid; grid-template-columns: 50px minmax(0,1fr);
    gap:10px; align-items:center; margin-bottom:10px;
  }
  .row--inline { display:flex; gap:10px; align-items:center; }

  label { color:var(--muted); user-select:none; }
  input, textarea, select {
    width:100%; max-width:100%; min-width:0;
    background:var(--input-bg); color:var(--input-fg);
    border:1px solid var(--input-border); border-radius:8px;
    padding:8px 10px; outline:none;
    transition:border .15s ease, box-shadow .15s ease;
  }
  input:focus, textarea:focus, select:focus {
    border-color:var(--focus);
    box-shadow:0 0 0 3px color-mix(in srgb, var(--focus) 20%, transparent);
  }
  textarea {
    min-height:180px; resize:vertical;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }

  /* chips de query */
  #queryArea { display:flex; flex-direction:column; gap:8px; }
  .chip {
    display:flex; align-items:center; gap:8px;
    padding:6px 8px; background:var(--chip-bg);
    border:1px solid var(--border); border-radius:999px;
  }
  .chip .kv { flex:1; display:grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap:8px; }
  .chip .kv input { min-width: 0; }
  .chip button.chip-remove {
    border:none; background:transparent; color:var(--muted);
    font-size:16px; line-height:16px; width:26px; height:26px;
    border-radius:50%; cursor:pointer;
  }
  .chip button.chip-remove:hover { background:rgba(127,127,127,.15); color:var(--text); }

  /* toolbar/botões */
  .toolbar { display:flex; gap:10px; justify-content:flex-end; margin-top:14px; flex-wrap: wrap; }
  .btn {
    appearance:none; border:1px solid var(--border);
    background:transparent; color:var(--text);
    padding:8px 12px; border-radius:8px; cursor:pointer;
    transition: background .15s ease, border .15s ease, transform .02s ease;
  }
  .btn:hover { background: rgba(127,127,127,.08); }
  .btn:active { transform: translateY(1px); }
  .btn.primary { background:var(--btn-bg); color:var(--btn-fg); border-color:transparent; }
  .btn.primary:hover { background:var(--btn-hover); }
  .btn.small { padding:6px 10px; font-size:12px; }

  /* cURL */
  .curl-wrap { min-height: 56px; } /* reserva espaço pra evitar “jump” */
  pre {
    background: rgba(127,127,127,.08); border:1px solid var(--border);
    border-radius:8px; padding:10px; margin:10px 0 0 0;
    max-height:220px; max-width:100%; overflow:auto; white-space: pre;
  }

  /* footer ações */
  .actions {
    position:sticky; bottom:0; background:var(--bg);
    padding-top:8px; margin-top:14px; border-top:1px solid var(--border);
    display:flex; gap:8px; justify-content:flex-end;
  }

  /* toast */
  .toast {
    position: fixed; right: 16px; bottom: 16px;
    background: var(--panel); border:1px solid var(--border);
    border-radius:8px; padding:10px 12px; box-shadow: var(--shadow);
    opacity:0; transform: translateY(6px);
    transition: opacity .15s ease, transform .15s ease; pointer-events:none;
  }
  .toast.show { opacity:1; transform: translateY(0); }
</style>
</head>

<body>
  <div class="container">
    <div class="header">
      <div class="title">
        <span class="badge">${route.method}</span>
        <h2 style="margin:0;">${route.path}</h2>
      </div>
      <div class="path-preview" id="fullPathPreview" title="Prévia do caminho completo"></div>
    </div>

    <!-- Presets -->
      <div class="card" style="margin-bottom: var(--gap);">
        <div style="display: flex; flex-direction: column; gap: 12px;">
          <!-- Linha 1: Carregar preset existente -->
          <div class="row" style="grid-template-columns: 50px 1fr auto auto; gap: 10px; align-items: center;">
            <label>Preset</label>
            <select id="presetSelect" style="min-width: 0;"></select>
            <button id="loadPreset" class="btn small" style="white-space: nowrap;">Carregar</button>
            <button id="deletePreset" class="btn small" style="white-space: nowrap;">Excluir</button>
          </div>
          
          <!-- Linha 2: Salvar novo preset -->
          <div class="row" style="grid-template-columns: 50px 1fr auto; gap: 10px; align-items: center;">
            <label>Salvar como</label>
            <input id="presetName" placeholder="Nome do preset" style="min-width: 0;" />
            <button id="savePreset" class="btn small" style="white-space: nowrap;">Salvar</button>
          </div>
        </div>
      </div>

    <!-- Global Prefix -->
    <div class="card" style="margin-bottom: var(--gap);">
      <div class="row">
        <label for="globalPrefix">Global prefix</label>
        <input id="globalPrefix" placeholder="/v1" />
      </div>
      <div class="row--inline" style="justify-content:flex-start; gap:8px;">
        <input id="applyGlobal" type="checkbox" />
        <label for="applyGlobal">Aplicar ao path</label>
        <span class="hint" style="color: var(--muted);">Prefixa todas as chamadas com o global prefix.</span>
      </div>
    </div>

    <div class="grid">
      <!-- Esquerda -->
      <div class="card">
        <div class="row"><label for="baseUrl">Base URL</label><input id="baseUrl" placeholder="http://localhost:3000" /></div>
        <div class="row"><label for="path">Path</label><input id="path" placeholder="/controller/route" /></div>

        <div class="section">
          <div class="section-title">Path params</div>
          <div id="ppArea" class="stack"></div>
          <div class="hint" style="color:var(--muted);">Detectados via caminho e <code>@Param()</code>.</div>
        </div>

        <div class="section">
          <div class="section-title" style="display:flex; align-items:center; justify-content:space-between;">
            <span>Query params</span>
            <button id="addQuery" type="button" class="btn small">+ Adicionar</button>
          </div>
          <div id="queryArea"></div>
        </div>

        <div class="section">
          <div class="section-title">Headers</div>
          <textarea id="headers" placeholder="Chave: Valor (um por linha)"></textarea>
        </div>

        <div class="section">
          <div class="row"><label for="bearer">Bearer Token</label><input id="bearer" placeholder="ey..." /></div>
          <div class="row--inline" style="margin-top:-4px;">
            <input id="bearerOn" type="checkbox" />
            <label for="bearerOn">Adicionar <code>Authorization: Bearer &lt;token&gt;</code></label>
          </div>
        </div>

        <div class="toolbar">
          <button id="previewCurl" class="btn">Pré-visualizar cURL</button>
          <button id="copyCurl" class="btn">Copiar cURL</button>
        </div>
        <div class="curl-wrap">
          <pre id="curlBox" style="display:none"></pre>
        </div>
      </div>

      <!-- Direita -->
      <div class="card" ${route.params.hasBody ? '' : 'style="display:none"'}>
        <div class="section-title" style="margin-bottom:8px; display: flex; align-items: center; justify-content: space-between;">
          <span>Body (JSON)</span>
          <div style="display: flex; gap: 8px; align-items: center;">
            ${route.params.bodyType ? `<span class="hint" style="color:var(--muted); font-size: 11px; font-weight: normal;">baseado em ${route.params.bodyType}</span>` : ''}
            ${route.params.bodyType ? `<button id="regenerateBody" class="btn small" title="Regenerar exemplo baseado no DTO">🔄</button>` : ''}
          </div>
        </div>
        <textarea id="bodyText" placeholder='{"exemplo": true}'></textarea>
        <div class="hint" style="color:var(--muted);">Enviado apenas para métodos com corpo (não GET/HEAD).</div>
      </div>
    </div>

    <div class="actions">
      <button id="resetRoute" class="btn">Resetar Rota</button>
      <button id="exportHttp" class="btn">Exportar .http</button>
      <button id="sendBtn" class="btn primary">Send</button>
    </div>

    <div id="toast" class="toast"></div>
  </div>

<script>
  const vscode = acquireVsCodeApi();
  const initial = ${initial};
  const last = ${lastJSON};
  const presetNames = ${namesJSON};
  const knownQP = ${knownQPJSON};
  const pathParams = ${pathParamsJSON};
  const routeMethod = '${route.method}';

  const el = (id) => document.getElementById(id);
  const toast = (msg) => {
    const t = el('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 1600);
  };

  // Função global para substituir path params
  function replacePathParams(path, pathParams) {
    let result = path;
    Object.entries(pathParams || {}).forEach(([key, value]) => {
      // Substitui :param pelo valor
      result = result.replace(new RegExp(':' + key + '\\\\b', 'g'), value || ':' + key);
    });
    return result;
  }

  // Prévia do caminho/base
  let updatePreview; // Variável para expor a função update
  (function wirePreview(){
    const preview = el('fullPathPreview');
    function ensureLeadingSlash(p){ if(!p) return '/'; return p.startsWith('/') ? p : '/' + p; }
    function joinPath(a,b){
      if (!a) return ensureLeadingSlash(b);
      if (!b) return ensureLeadingSlash(a);
      const left = a.endsWith('/') ? a.slice(0,-1) : a;
      const right = b.startsWith('/') ? b : '/' + b;
      return left + right;
    }
    function update(){
      const base = el('baseUrl')?.value || '';
      const gp = el('globalPrefix')?.value || '';
      const use = el('applyGlobal')?.checked;
      const p = el('path')?.value || '';
      
      // Coleta path params atuais
      const pps = {};
      document.querySelectorAll('[data-pp]').forEach(i => {
        const key = i.getAttribute('data-pp');
        pps[key] = i.value || ':' + key;
      });
      
      // Substitui path params no path
      const pathWithParams = replacePathParams(p, pps);
      
      const full = (base || '') + joinPath(use && gp ? gp : '', pathWithParams || '/');
      preview.textContent = full;
    }
    updatePreview = update; // Expõe a função para uso externo
    ['baseUrl','globalPrefix','applyGlobal','path'].forEach(id => {
      const i = el(id);
      if (!i) return;
      i.addEventListener(id==='applyGlobal'?'change':'input', update);
    });
    update();
  })();

  // Build UI inicial
  function build() {
    el('baseUrl').value = (last && last.baseUrl) || initial.baseUrl;
    el('path').value = (last && last.path) || initial.path;
    el('headers').value = ((last && last.headers) || initial.headers).join('\\n');
    el('bearer').value = (last && last.bearerToken) || '';
    el('bearerOn').checked = !!(last && last.includeBearer);
    el('applyGlobal').checked = (last && typeof last.applyGlobal !== 'undefined') ? !!last.applyGlobal : !!initial.applyGlobal;
    el('globalPrefix').value = (last && last.globalPrefix) || initial.globalPrefix || '';

    // body text
    const bodyTextEl = el('bodyText');
    if (bodyTextEl) {
      bodyTextEl.value = (last && last.bodyText) || initial.bodyText || '';
    }

    // presets
    const sel = el('presetSelect');
    sel.innerHTML = '<option value="">-- selecione --</option>' + presetNames.map(n => '<option>'+n+'</option>').join('');

    // path params
    const ppArea = el('ppArea'); ppArea.innerHTML = '';
    pathParams.forEach(function(k){
      const val = (last && last.pathParams && last.pathParams[k]) || '';
      const row = document.createElement('div'); row.className = 'row';
      row.innerHTML = '<label>:'+k+'</label><input data-pp="'+k+'" placeholder="'+k+'" />';
      ppArea.appendChild(row);
      const input = row.querySelector('input');
      input.value = val;
      // Adiciona listener para atualizar preview quando path param muda
      input.addEventListener('input', updatePreview);
    });

    // query params (chips)
    const qArea = el('queryArea'); qArea.innerHTML = '';
    const lastQuery = (last && last.query) || {};
    knownQP.forEach(k => addQueryChip(k, lastQuery[k] || ''));
    Object.keys(lastQuery).forEach(k => { if (!knownQP.includes(k)) addQueryChip(k, lastQuery[k]); });
  }

  function addQueryChip(key, value){
    const qArea = el('queryArea');
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.innerHTML =
      '<div class="kv">' +
      '  <input class="qkey" placeholder="chave" />' +
      '  <input class="qval" placeholder="valor" />' +
      '</div>' +
      '<button class="chip-remove" type="button" title="Remover">&times;</button>';
    qArea.appendChild(chip);
    chip.querySelector('.qkey').value = key || '';
    chip.querySelector('.qval').value = value || '';
  }

  // Remoção de chips por delegation
  el('queryArea').addEventListener('click', function(e){
    const btn = e.target && e.target.closest('.chip-remove');
    if (!btn) return;
    const chip = btn.closest('.chip');
    if (chip) chip.remove();
  });

  build();

  el('addQuery').onclick = () => addQueryChip('', '');

  // Regenerar body baseado no DTO
  const regenerateBtn = el('regenerateBody');
  if (regenerateBtn) {
    regenerateBtn.onclick = () => {
      vscode.postMessage({ type: 'regenerateBody' });
      toast('Regenerando exemplo do body...');
    };
  }

  function collect(){
    const pps = {};
    document.querySelectorAll('[data-pp]').forEach(i => {
      const key = i.getAttribute('data-pp');
      pps[key] = i.value || '';
    });

    const query = {};
    document.querySelectorAll('#queryArea .chip').forEach(chip => {
      const k = chip.querySelector('.qkey').value;
      const v = chip.querySelector('.qval').value;
      if (k && String(v).length) query[k] = v;
    });

    const headers = (el('headers').value || '').split('\\n').map(s => s.trim()).filter(Boolean);

    return {
      baseUrl: el('baseUrl').value || '${baseUrl}',
      path: el('path').value || '${route.path}',
      pathParams: pps,
      query: query,
      headers: headers,
      bearerToken: el('bearer').value || '',
      includeBearer: el('bearerOn').checked,
      bodyText: (el('bodyText') && el('bodyText').value) || '',
      applyGlobal: el('applyGlobal').checked,
      globalPrefix: el('globalPrefix').value || ''
    };
  }

  function validateJsonIfPresent() {
    const ta = el('bodyText');
    if (!ta) return { ok: true };
    const text = ta.value.trim();
    if (!text) return { ok: true };
    try { JSON.parse(text); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e) }; }
  }

  function joinPath(a, b) {
    if (!a) return ensureLeadingSlash(b);
    if (!b) return ensureLeadingSlash(a);
    const left = a.endsWith('/') ? a.slice(0, -1) : a;
    const right = b.startsWith('/') ? b : '/' + b;
    return left + right;
  }
  function ensureLeadingSlash(p){ if(!p) return '/'; return p.startsWith('/') ? p : '/' + p; }
  function joinUrl(base, path){
    if (base.endsWith('/') && path.startsWith('/')) return base.slice(0, -1) + path;
    if (!base.endsWith('/') && !path.startsWith('/')) return base + '/' + path;
    return base + path;
  }
  function buildQueryString(obj){
    const parts = [];
    Object.entries(obj || {}).forEach(([k, v]) => {
      if (k && v !== undefined && v !== null && String(v).length) {
        parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
      }
    });
    return parts.join('&');
  }

  function buildCurlPreview(payload) {
    const prefix = (payload.applyGlobal && payload.globalPrefix) ? payload.globalPrefix : '';
    const pathWithParams = replacePathParams(payload.path, payload.pathParams);
    const path = joinPath(prefix, pathWithParams);
    const qs = buildQueryString(payload.query || {});
    const url = joinUrl(payload.baseUrl, path) + (qs ? '?' + qs : '');
    const headers = (payload.headers || []).slice();
    if (payload.includeBearer && payload.bearerToken && !headers.some(h => /^Authorization\\s*:/i.test(h))) {
      headers.push('Authorization: Bearer ' + payload.bearerToken);
    }
    const hasBody = payload.bodyText && payload.bodyText.trim().length > 0 && routeMethod !== 'GET' && routeMethod !== 'HEAD';
    if (hasBody && !headers.some(h => /^Content-Type\\s*:/i.test(h))) {
      headers.push('Content-Type: application/json');
    }
    let curl = 'curl -i -X ' + routeMethod + ' "' + url + '"';
    headers.forEach(h => curl += ' -H "' + h.replace(/"/g, '\\"') + '"');
    if (hasBody) curl += " -d '" + payload.bodyText.replace(/'/g, "'\\\\''") + "'";
    return curl;
  }
  
  el('previewCurl').onclick = () => {
    const val = validateJsonIfPresent();
    if (!val.ok) { alert('Body JSON inválido: ' + val.error); return; }
    const curl = buildCurlPreview(collect());
    const pre = el('curlBox'); pre.textContent = curl; pre.style.display = 'block';
  };

  el('copyCurl').onclick = async () => {
    const val = validateJsonIfPresent();
    if (!val.ok) { alert('Body JSON inválido: ' + val.error); return; }
    const curl = buildCurlPreview(collect());
    try {
      await navigator.clipboard.writeText(curl);
      toast('cURL copiado para a área de transferência');
    } catch {
      // fallback
      const ta = document.createElement('textarea');
      ta.value = curl;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast('cURL copiado'); }
      catch { alert('Não foi possível copiar o cURL.'); }
      document.body.removeChild(ta);
    }
    const pre = el('curlBox'); if (pre.style.display === 'none') { pre.textContent = curl; pre.style.display = 'block'; }
  };

  el('sendBtn').onclick = () => {
    const val = validateJsonIfPresent();
    if (!val.ok) { alert('Body JSON inválido: ' + val.error); return; }
    vscode.postMessage({ type: 'submit', payload: collect() });
  };

  el('exportHttp').onclick = () => {
    const val = validateJsonIfPresent();
    if (!val.ok) { alert('Body JSON inválido: ' + val.error); return; }
    vscode.postMessage({ type: 'exportHttp', payload: collect() });
  };

  // Presets
  el('savePreset').onclick = () => {
    const name = el('presetName').value.trim();
    if (!name) { alert('Informe um nome para o preset.'); return; }
    vscode.postMessage({ type: 'savePreset', payload: { name, data: collect() } });
  };
  el('loadPreset').onclick = () => {
    const name = el('presetSelect').value;
    if (!name) return;
    vscode.postMessage({ type: 'requestPreset', payload: { name } });
  };
  el('deletePreset').onclick = () => {
    const name = el('presetSelect').value;
    if (!name) return;
    vscode.postMessage({ type: 'deletePreset', payload: { name } });
  };
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'presetList') {
      const sel = el('presetSelect');
      sel.innerHTML = '<option value="">-- selecione --</option>' + msg.payload.map((n) => '<option>'+n+'</option>').join('');
    }
    if (msg.type === 'presetData') {
      applyPreset(msg.payload);
    }
    if (msg.type === 'updateBody') {
      const bodyTextarea = el('bodyText');
      if (bodyTextarea) {
        bodyTextarea.value = msg.payload.bodyText;
        toast('Body regenerado com sucesso!');
      }
    }
    if (msg.type === 'showToast') {
      toast(msg.payload.message);
    }
    if (msg.type === 'applyGlobalReset') {
      // Aplica as configurações globais atuais
      const globalSettings = msg.payload;
      
      // Reset dos campos principais
      el('baseUrl').value = globalSettings.baseUrl;
      el('path').value = initial.path; // Path da rota original
      el('headers').value = globalSettings.headers.join('\\n');
      el('bearer').value = '';
      el('bearerOn').checked = false;
      el('applyGlobal').checked = true; // Ativa global prefix por padrão
      el('globalPrefix').value = globalSettings.globalPrefix;
      
      // Reset body text se existir
      const bodyTextEl = el('bodyText');
      if (bodyTextEl) {
        bodyTextEl.value = globalSettings.bodyText;
      }
      
      // Reset path params
      document.querySelectorAll('[data-pp]').forEach(i => {
        i.value = '';
      });
      
      // Reset query params - remove todos os chips e adiciona apenas os conhecidos vazios
      const qArea = el('queryArea');
      qArea.innerHTML = '';
      knownQP.forEach(k => addQueryChip(k, ''));
      
      // Reset preset selection
      el('presetSelect').value = '';
      el('presetName').value = '';
      
      // Atualiza preview
      if (typeof updatePreview === 'function') {
        updatePreview();
      }
      
      toast('Rota resetada com configurações globais atuais');
    }
  });

  function applyPreset(p){
    el('baseUrl').value = p.baseUrl || '${baseUrl}';
    el('path').value = p.path || '${route.path}';
    el('headers').value = (p.headers || []).join('\\n');
    el('bearer').value = p.bearerToken || '';
    el('bearerOn').checked = !!p.includeBearer;
    el('applyGlobal').checked = !!p.applyGlobal;
    el('globalPrefix').value = p.globalPrefix || (initial.globalPrefix || '');

    // body text
    const bodyTextEl = el('bodyText');
    if (bodyTextEl) {
      bodyTextEl.value = p.bodyText || '';
    }

    document.getElementById('ppArea').querySelectorAll('[data-pp]').forEach((i) => {
      const key = i.getAttribute('data-pp');
      i.value = (p.pathParams && p.pathParams[key]) || '';
    });

    const qArea = el('queryArea'); qArea.innerHTML = '';
    const qp = p.query || {};
    const keys = Object.keys(qp);
    knownQP.forEach(k => addQueryChip(k, qp[k] || ''));
    Object.keys(qp).forEach(k => { if (!knownQP.includes(k)) addQueryChip(k, qp[k]); });
  }

  // Reset Route Button
  const resetBtn = el('resetRoute');
  if (resetBtn) {
    resetBtn.onclick = () => {
      // Solicita as configurações globais atuais do VS Code
      vscode.postMessage({ type: 'resetToGlobalSettings' });
    };
  }
</script>
</body>
</html>`;
}

/** -------------------- Settings HTML -------------------- */
function getSettingsHtml(config: { baseUrl: string; defaultHeaders: string[]; globalPrefix: string }) {
  const headersText = config.defaultHeaders.join('\\n');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<style>
  :root{
    --bg: var(--vscode-editor-background);
    --panel: var(--vscode-sideBar-background);
    --text: var(--vscode-foreground);
    --muted: var(--vscode-descriptionForeground);
    --border: var(--vscode-widget-border);
    --input-bg: var(--vscode-input-background);
    --input-fg: var(--vscode-input-foreground);
    --input-border: var(--vscode-input-border);
    --btn-bg: var(--vscode-button-background);
    --btn-fg: var(--vscode-button-foreground);
    --btn-hover: var(--vscode-button-hoverBackground);
    --focus: var(--vscode-focusBorder);
    --radius: 8px;
    --gap: 14px;
  }
  
  *, *::before, *::after { box-sizing: border-box; }
  html, body {
    padding:0; margin:0;
    background:var(--bg); color:var(--text);
    font:13px/1.45 -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
  }
  
  .container { padding: 20px; max-width: 600px; margin: 0 auto; }
  .header { margin-bottom: 24px; }
  .title { font-size: 18px; font-weight: 600; margin-bottom: 8px; }
  .subtitle { color: var(--muted); }
  
  .form-group { margin-bottom: 20px; }
  label { 
    display: block; 
    margin-bottom: 6px; 
    font-weight: 500; 
    color: var(--text);
  }
  .description {
    font-size: 12px;
    color: var(--muted);
    margin-bottom: 8px;
  }
  
  input, textarea {
    width: 100%;
    background: var(--input-bg);
    color: var(--input-fg);
    border: 1px solid var(--input-border);
    border-radius: var(--radius);
    padding: 10px 12px;
    outline: none;
    transition: border .15s ease, box-shadow .15s ease;
  }
  
  input:focus, textarea:focus {
    border-color: var(--focus);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--focus) 20%, transparent);
  }
  
  textarea {
    min-height: 120px;
    resize: vertical;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }
  
  .btn {
    background: var(--btn-bg);
    color: var(--btn-fg);
    border: none;
    border-radius: var(--radius);
    padding: 10px 20px;
    cursor: pointer;
    font-weight: 500;
    transition: background .15s ease;
  }
  
  .btn:hover {
    background: var(--btn-hover);
  }
  
  .btn:active {
    transform: translateY(1px);
  }
  
  .actions {
    display: flex;
    gap: 12px;
    justify-content: flex-end;
    margin-top: 30px;
  }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <div class="title">Configurações do Nest Caller</div>
    <div class="subtitle">Configure as configurações padrão da extensão</div>
  </div>
  
  <div class="form-group">
    <label for="baseUrl">Base URL</label>
    <div class="description">Base URL da sua API Nest.</div>
    <input type="text" id="baseUrl" value="${config.baseUrl}" placeholder="http://localhost:3000" />
  </div>
  
  <div class="form-group">
    <label for="defaultHeaders">Default Headers</label>
    <div class="description">Headers padrão (um por linha, "Chave: Valor").</div>
    <textarea id="defaultHeaders" placeholder="Content-Type: application/json">${headersText}</textarea>
  </div>
  
  <div class="form-group">
    <label for="globalPrefix">Global Prefix</label>
    <div class="description">Global prefix manual (ex.: /v1). Se vazio, será detectado do main.ts quando possível.</div>
    <input type="text" id="globalPrefix" value="${config.globalPrefix}" placeholder="/v1" />
  </div>
  
  <div class="actions">
    <button class="btn" onclick="saveSettings()">Salvar Configurações</button>
  </div>
</div>

<script>
  const vscode = acquireVsCodeApi();
  
  function saveSettings() {
    const baseUrl = document.getElementById('baseUrl').value.trim() || 'http://localhost:3000';
    const headersText = document.getElementById('defaultHeaders').value.trim();
    const defaultHeaders = headersText ? headersText.split('\\n').map(h => h.trim()).filter(Boolean) : ['Content-Type: application/json'];
    const globalPrefix = document.getElementById('globalPrefix').value.trim();
    
    vscode.postMessage({
      type: 'saveSettings',
      payload: { baseUrl, defaultHeaders, globalPrefix }
    });
  }
</script>
</body>
</html>`;
}
