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
    provideCodeLenses(document) {
      if (!document.fileName.endsWith('.ts')) return [];
      try {
        const routes = extractRoutes(document);
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
}

export function deactivate() { }

/** -------------------- Extração de rotas -------------------- */
function extractRoutes(document: vscode.TextDocument): RouteInfo[] {
  const source = ts.createSourceFile(
    document.fileName,
    document.getText(),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  const routes: RouteInfo[] = [];

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
        const paramsInfo = { pathParams: new Set<string>(), queryParams: new Set<string>(), hasBody: false };
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
            }
          });
        });

        const methodName = node.name && ts.isIdentifier(node.name) ? node.name.text : 'handler';
        const line = document.positionAt(node.getStart()).line;

        routes.push({
          method,
          path: composedPath,
          controllerPrefix,
          line,
          controllerMethodName: methodName,
          params: {
            pathParams: Array.from(paramsInfo.pathParams),
            queryParams: Array.from(paramsInfo.queryParams),
            hasBody: paramsInfo.hasBody
          }
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
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
      const fullPath = joinPath(prefixToUse, payload.path);
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
    bodyText: '',
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
    display:grid; grid-template-columns: 130px minmax(0,1fr);
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
      <div class="row" style="grid-template-columns:130px 1fr 1fr auto;">
        <label>Preset</label>
        <select id="presetSelect"></select>
        <input id="presetName" placeholder="Nome do preset" />
        <div class="row--inline" style="justify-content:flex-end;">
          <button id="loadPreset" class="btn small">Carregar</button>
          <button id="savePreset" class="btn small">Salvar</button>
          <button id="deletePreset" class="btn small">Excluir</button>
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
        <div class="section-title" style="margin-bottom:8px;">Body (JSON)</div>
        <textarea id="bodyText" placeholder='{"exemplo": true}'></textarea>
        <div class="hint" style="color:var(--muted);">Enviado apenas para métodos com corpo (não GET/HEAD).</div>
      </div>
    </div>

    <div class="actions">
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

  const el = (id) => document.getElementById(id);
  const toast = (msg) => {
    const t = el('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 1600);
  };

  // Prévia do caminho/base
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
      const full = (base || '') + joinPath(use && gp ? gp : '', p || '/');
      preview.textContent = full;
    }
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
      row.querySelector('input').value = val;
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
    const path = joinPath(prefix, payload.path);
    const qs = buildQueryString(payload.query || {});
    const url = joinUrl(payload.baseUrl, path) + (qs ? '?' + qs : '');
    const headers = (payload.headers || []).slice();
    if (payload.includeBearer && payload.bearerToken && !headers.some(h => /^Authorization\\s*:/i.test(h))) {
      headers.push('Authorization: Bearer ' + payload.bearerToken);
    }
    let curl = 'curl -i -X ${route.method} "' + url + '"';
    headers.forEach(h => curl += ' -H "' + h.replace(/"/g, '\\"') + '"');
    const hasBody = payload.bodyText && payload.bodyText.trim().length > 0 && '${route.method}' !== 'GET' && '${route.method}' !== 'HEAD';
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
  });

  function applyPreset(p){
    el('baseUrl').value = p.baseUrl || '${baseUrl}';
    el('path').value = p.path || '${route.path}';
    el('headers').value = (p.headers || []).join('\\n');
    el('bearer').value = p.bearerToken || '';
    el('bearerOn').checked = !!p.includeBearer;
    el('applyGlobal').checked = !!p.applyGlobal;
    el('globalPrefix').value = p.globalPrefix || (initial.globalPrefix || '');

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
</script>
</body>
</html>`;
}
