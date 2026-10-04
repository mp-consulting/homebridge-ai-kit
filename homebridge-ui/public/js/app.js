(() => {

  const PLATFORM = 'HomebridgeAiKit';
  const DEFAULT_MODELS = {
    anthropic: 'claude-sonnet-5-5',
    openai: 'gpt-6.1-sol',
    gemini: 'gemini-3.8-flash',
    'openai-compatible': 'llama3.1',
  };
  const MODEL_HELP = {
    anthropic: 'e.g. claude-sonnet-5-5 (default), claude-haiku-4-5-20251001 (cheapest), claude-opus-5-5 (most capable).',
    openai: 'e.g. gpt-6.1-sol (default), gpt-6-luna (cheapest), gpt-6-astra (most capable).',
    gemini: 'e.g. gemini-3.8-flash or gemini-3.5-flash-lite.',
    'openai-compatible': 'The model name your server knows, e.g. llama3.1 or qwen3.',
  };

  const $ = (id) => document.getElementById(id);
  let block = { platform: PLATFORM, name: 'AI Kit' };
  let snippetTab = 'claudeDesktop';
  const ai = window.MpKit && window.MpKit.ai;

  function num(value) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }

  function list(value) {
    const items = value.split(',').map((s) => s.trim()).filter(Boolean);
    return items.length ? items : undefined;
  }

  function clean(obj) {
    Object.keys(obj).forEach((k) => {
      if (obj[k] === undefined || obj[k] === '') {
        delete obj[k]; 
      }
    });
    return obj;
  }

  /**
   * The block as edited in the form. Fields the form doesn't show (e.g. the
   * `homebridgeTokenId` Glass UI stores to revoke its API token) are kept.
   */
  function readForm() {
    const mcp = Object.assign({}, block.mcp);
    const http = clean(Object.assign({}, mcp.http, {
      enabled: $('http-enabled').checked,
      host: $('http-host').value.trim(),
      port: num($('http-port').value),
      token: $('http-token').value.trim(),
      homebridgeUrl: $('http-hb-url').value.trim(),
      homebridgeToken: $('http-hb-token').value.trim(),
      homebridgeCertFingerprint: $('http-hb-cert-fingerprint').value.trim(),
      homebridgeCertPath: $('http-hb-cert-path').value.trim(),
      readOnly: $('http-read-only').checked,
      allowedOrigins: list($('http-allowed-origins').value),
      auditLog: $('http-audit-log').checked,
      auditLogPath: $('http-audit-log-path').value.trim(),
    }));
    mcp.http = http;
    const provider = $('provider').value;
    return clean(Object.assign({}, block, {
      platform: PLATFORM,
      enabled: $('enabled').checked,
      provider: provider,
      model: $('model').value.trim(),
      apiKey: $('apiKey').value.trim(),
      baseUrl: provider === 'openai-compatible' ? $('baseUrl').value.trim() : undefined,
      contextTokens: provider === 'openai-compatible' ? num($('contextTokens').value) : undefined,
      maxOutputTokens: num($('maxOutputTokens').value),
      mcp: mcp,
    }));
  }

  function fillForm(b) {
    const http = (b.mcp && b.mcp.http) || {};
    $('enabled').checked = b.enabled !== false;
    $('provider').value = b.provider || 'anthropic';
    $('model').value = b.model || '';
    $('apiKey').value = b.apiKey || '';
    $('baseUrl').value = b.baseUrl || '';
    $('contextTokens').value = b.contextTokens || '';
    $('maxOutputTokens').value = b.maxOutputTokens || '';
    $('http-enabled').checked = http.enabled === true;
    $('http-host').value = http.host || '';
    $('http-port').value = http.port || '';
    $('http-token').value = http.token || '';
    $('http-hb-url').value = http.homebridgeUrl || '';
    $('http-hb-token').value = http.homebridgeToken || '';
    $('http-hb-cert-fingerprint').value = http.homebridgeCertFingerprint || '';
    $('http-hb-cert-path').value = http.homebridgeCertPath || '';
    $('http-read-only').checked = http.readOnly === true;
    $('http-allowed-origins').value = (http.allowedOrigins || []).join(', ');
    $('http-audit-log').checked = http.auditLog !== false;
    $('http-audit-log-path').value = http.auditLogPath || '';
  }

  function refreshVisibility() {
    const provider = $('provider').value;
    const local = provider === 'openai-compatible';
    $('baseUrl-group').classList.toggle('d-none', !local);
    $('contextTokens-group').classList.toggle('d-none', !local);
    $('model').placeholder = DEFAULT_MODELS[provider];
    $('model-help').textContent = MODEL_HELP[provider] + ' Leave empty for the default.';
    $('http-settings').classList.toggle('d-none', !$('http-enabled').checked);
    $('http-audit-log-path-group').classList.toggle('d-none', !$('http-audit-log').checked);
  }

  let saveTimer;
  function save() {
    block = readForm();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      homebridge.updatePluginConfig([block]).catch((e) => {
        homebridge.toast.error(e.message || String(e), 'Could not update the config');
      });
    }, 250);
    refreshVisibility();
    renderSnippet();
  }

  function renderSnippet() {
    const http = block.mcp && block.mcp.http;
    const body = {
      homebridgeUrl: window.location.origin,
      includeToken: $('include-token').checked,
    };
    if (http && http.enabled) {
      body.http = { host: http.host || '127.0.0.1', port: http.port || 8582, token: http.token };
    }
    homebridge.request('/mcp/snippets', body).then((snippets) => {
      $('snippet').textContent = snippets[snippetTab];
    });
  }

  function testConnection() {
    const result = $('test-result');
    $('status').textContent = '';
    const answer = ai ? ai.renderAnswer(result, { title: 'Connection test', note: '' }) : null;
    if (!answer) {
      result.textContent = 'Testing…'; 
    }
    homebridge.request('/ai/test', readForm()).then((res) => {
      if (res.ok) {
        const text = 'Connected to **' + res.provider + '** using `' + res.model + '` in ' + res.latencyMs + ' ms. Reply: ' + (res.reply || '(empty)');
        if (answer) {
          answer.done(text); 
        } else {
          result.textContent = text; 
        }
      } else if (answer) {
        answer.error(res.message);
      } else {
        result.textContent = res.message;
      }
    }, (e) => {
      if (answer) {
        answer.error(e); 
      } else {
        result.textContent = e.message || String(e); 
      }
    });
  }

  /**
   * The Homebridge user's theme (light, dark or auto), applied by ui-kit:
   * lib/theme-boot.js sets it before first paint, MpKit.Theme.init() then
   * follows the Homebridge setting and the system preference.
   */
  function applyUserTheme() {
    if (window.MpKit && window.MpKit.Theme) {
      window.MpKit.Theme.init();
    }
  }

  function init() {
    applyUserTheme();
    const slot = $('test-button-slot');
    slot.innerHTML = ai
      ? ai.renderButton({ id: 'test-connection', label: 'Test connection' })
      : '<button type="button" class="btn btn-primary" id="test-connection">Test connection</button>';
    if (ai) {
      $('assistant-badge').innerHTML = ai.renderBadge('Assistant'); 
    }
    $('test-connection').addEventListener('click', testConnection);

    $('toggle-key').addEventListener('click', () => {
      $('apiKey').type = $('apiKey').type === 'password' ? 'text' : 'password';
    });
    $('generate-token').addEventListener('click', () => {
      homebridge.request('/mcp/token').then((res) => {
        $('http-token').value = res.token;
        save();
      });
    });
    document.querySelectorAll('[data-snippet]').forEach((button) => {
      button.addEventListener('click', () => {
        document.querySelectorAll('[data-snippet]').forEach((b) => {
          b.classList.remove('active'); 
        });
        button.classList.add('active');
        snippetTab = button.dataset.snippet;
        renderSnippet();
      });
    });
    $('copy-snippet').addEventListener('click', () => {
      navigator.clipboard.writeText($('snippet').textContent).then(() => {
        homebridge.toast.success('Copied to the clipboard.');
      });
    });
    $('include-token').addEventListener('change', renderSnippet);
    document.querySelectorAll('input, select').forEach((el) => {
      if (el.id !== 'include-token') {
        el.addEventListener('change', save);
        el.addEventListener('input', save);
      }
    });

    homebridge.getPluginConfig().then((blocks) => {
      block = blocks.find((b) => {
        return b.platform === PLATFORM; 
      }) || block;
      fillForm(block);
      refreshVisibility();
      renderSnippet();
      if (!blocks.length) {
        save(); 
      }
      homebridge.hideSpinner();
    });
  }

  homebridge.addEventListener('ready', init);
})();
