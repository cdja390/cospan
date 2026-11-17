/* global window, document, fetch, URLSearchParams */
(function () {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token') || '';
  const initialConversationId = params.get('conversationId') || null;
  let currentWorkspace = params.get('workspace') || '';
  let currentConversationId = initialConversationId;
  const listeners = new Set();

  function parseCssColorLuminance(rawColor) {
    const c = String(rawColor || '').trim();
    const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
    if (hexMatch) {
      const hex = hexMatch[1];
      const full =
        hex.length === 3
          ? hex
              .split('')
              .map((ch) => ch + ch)
              .join('')
          : hex;
      const r = parseInt(full.slice(0, 2), 16);
      const g = parseInt(full.slice(2, 4), 16);
      const b = parseInt(full.slice(4, 6), 16);
      return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    }
    const rgbMatch = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(c);
    if (rgbMatch) {
      const r = Number(rgbMatch[1]);
      const g = Number(rgbMatch[2]);
      const b = Number(rgbMatch[3]);
      return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    }
    return null;
  }

  function applyThemeVariables(cssVariables) {
    if (!cssVariables || typeof cssVariables !== 'object') return;
    for (const [key, value] of Object.entries(cssVariables)) {
      if (typeof key === 'string' && key.startsWith('--') && typeof value === 'string') {
        document.documentElement.style.setProperty(key, value);
      }
    }
    const bgSample =
      cssVariables['--background'] ||
      cssVariables['--editor-background'] ||
      cssVariables['--vscode-editor-background'] ||
      '';
    const lum = parseCssColorLuminance(bgSample);
    if (lum !== null) {
      document.documentElement.dataset.cospanTheme = lum < 0.5 ? 'dark' : 'light';
    }
  }

  function notifySubscribers() {
    for (const fn of listeners) {
      try {
        fn({ workspaceLabel: currentWorkspace, sessionId: currentConversationId });
      } catch {
        /* ignore subscriber errors */
      }
    }
  }

  window.addEventListener('message', (event) => {
    const data = event && event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'theme-change') {
      applyThemeVariables(data.payload && data.payload.cssVariables);
      return;
    }
    if (data.type === 'workspace-change') {
      const uris = data.payload && data.payload.workspaceUris;
      const nextWorkspace = Array.isArray(uris) && uris.length > 0 ? String(uris[0] || '') : '';
      const nextConv =
        (data.payload && data.payload.conversationId) || currentConversationId || null;
      if (nextWorkspace !== currentWorkspace || nextConv !== currentConversationId) {
        currentWorkspace = nextWorkspace;
        currentConversationId = nextConv;
        notifySubscribers();
      }
    }
  });

  function buildHeaders(extra) {
    const headers = Object.assign({}, extra || {});
    if (token) headers['X-Sidecar-Token'] = token;
    return headers;
  }

  async function fetchJson(url, options) {
    const res = await fetch(url, options);
    let data;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      const msg = (data && (data.error || data.message)) || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data || {};
  }

  function boot() {
    if (document.body) {
      document.body.style.margin = '0';
      document.body.style.padding = '0';
      document.body.style.height = '100vh';
      document.body.style.overflow = 'hidden';
      document.body.style.background = 'var(--background, transparent)';
    }
    const container = document.getElementById('cospan-root');
    if (!container || !window.CospanBoard) return;

    window.CospanBoard.mount(container, {
      host: 'agy',
      getInitialState() {
        return {
          workspaceLabel: currentWorkspace,
          sessionId: currentConversationId,
        };
      },
      subscribe(onUpdate) {
        listeners.add(onUpdate);
        return () => listeners.delete(onUpdate);
      },
      fetchBoard({ scope }) {
        const q = new URLSearchParams();
        if (currentWorkspace) q.set('workspace', currentWorkspace);
        if (currentConversationId) q.set('conversationId', currentConversationId);
        if (scope) q.set('scope', scope);
        return fetchJson(`/api/board?${q.toString()}`, { headers: buildHeaders() });
      },
      fetchDetail(jobId) {
        const q = new URLSearchParams({ id: jobId });
        if (currentWorkspace) q.set('workspace', currentWorkspace);
        return fetchJson(`/api/job?${q.toString()}`, { headers: buildHeaders() });
      },
      cancelJob(jobId) {
        return fetchJson('/api/cancel', {
          method: 'POST',
          headers: buildHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ workspace: currentWorkspace, id: jobId }),
        });
      },
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
