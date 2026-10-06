import * as vscode from 'vscode';
import { AccountManager, AccountEntry } from '../services/accountManager';
import { CONSTANTS } from '../utils/constants';

export class HubPanel {
  public static currentPanel: HubPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];

  public static toggle(extensionUri: vscode.Uri): void {
    if (HubPanel.currentPanel) {
      HubPanel.currentPanel.dispose();
    } else {
      HubPanel.show(extensionUri);
    }
  }

  public static show(extensionUri: vscode.Uri): void {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (HubPanel.currentPanel) {
      HubPanel.currentPanel._panel.reveal(column);
      HubPanel.currentPanel.updateContent();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'gravihop.hub',
      'GraviHop',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      }
    );

    HubPanel.currentPanel = new HubPanel(panel, extensionUri);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._extensionUri = extensionUri;

    this._panel.webview.html = this.getHtmlContent();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        const manager = AccountManager.getInstance();
        switch (message.command) {
          case 'close':
            this.dispose();
            break;
          case 'switch':
            if (message.accountId) {
              await manager.switchToAccount(message.accountId);
              this.updateContent();
            }
            break;
          case 'delete':
            if (message.accountId) {
              await manager.removeAccount(message.accountId);
              this.updateContent();
            }
            break;
          case 'capture':
            await manager.captureCurrentAccount(true);
            this.updateContent();
            break;
          case 'login':
            await manager.loginWithGoogleBrowser();
            this.updateContent();
            break;
          case 'nativeLogin':
            await vscode.commands.executeCommand('gravihop.loginNative');
            this.updateContent();
            break;
          case 'refresh':
            await manager.refreshActiveQuota();
            this.updateContent();
            break;
          case 'restartLS':
            await vscode.commands.executeCommand('antigravity.restartLanguageServer');
            vscode.window.showInformationMessage('GraviHop: Language Server restarted.');
            break;
        }
      },
      null,
      this._disposables
    );

    AccountManager.getInstance().onDidChangeAccounts(() => {
      this.updateContent();
    });

    setTimeout(() => {
      this.updateContent();
    }, 40);
  }

  public updateContent(): void {
    if (!this._panel) {
      return;
    }
    const manager = AccountManager.getInstance();
    const accounts = manager.getAccounts();
    const activeAccount = manager.getActiveAccount();

    this._panel.webview.postMessage({
      type: 'state',
      accounts,
      activeId: activeAccount?.id || null,
    });
  }

  public dispose(): void {
    HubPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }

  private getHtmlContent(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GraviHop</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background, #1e1e1e);
      --card-bg: var(--vscode-sideBar-background, #252526);
      --border: var(--vscode-widget-border, #333333);
      --text: var(--vscode-foreground, #cccccc);
      --text-muted: var(--vscode-descriptionForeground, #858585);
      --btn-bg: var(--vscode-button-background, #0078d4);
      --btn-fg: var(--vscode-button-foreground, #ffffff);
      --btn-hover: var(--vscode-button-hoverBackground, #026ec1);
      --btn-sec-bg: var(--vscode-button-secondaryBackground, #313131);
      --btn-sec-fg: var(--vscode-button-secondaryForeground, #cccccc);
      --btn-sec-hover: var(--vscode-button-secondaryHoverBackground, #3c3c3c);
      --input-bg: var(--vscode-input-background, #2d2d2d);
      --input-border: var(--vscode-input-border, #3c3c3c);
      --badge-active: #22c55e;
      --badge-warn: #eab308;
      --badge-error: #ef4444;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
      font-size: 13px;
      line-height: 1.4;
      padding: 24px 16px 40px;
      display: flex;
      justify-content: center;
      user-select: none;
    }

    .modal-container {
      width: 100%;
      max-width: 680px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    /* Header */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border);
    }

    .header-left {
      display: flex;
      align-items: baseline;
      gap: 10px;
    }

    .title {
      font-size: 16px;
      font-weight: 600;
      color: var(--text);
    }

    .count-label {
      font-size: 12px;
      color: var(--text-muted);
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    /* Buttons */
    button {
      font-family: inherit;
      font-size: 12px;
      border-radius: 4px;
      border: 1px solid transparent;
      padding: 5px 10px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: background-color 120ms ease;
    }

    .btn-primary {
      background: var(--btn-bg);
      color: var(--btn-fg);
    }

    .btn-primary:hover {
      background: var(--btn-hover);
    }

    .btn-secondary {
      background: var(--btn-sec-bg);
      color: var(--btn-sec-fg);
      border-color: var(--border);
    }

    .btn-secondary:hover {
      background: var(--btn-sec-hover);
    }

    .btn-icon {
      padding: 5px 8px;
      color: var(--text-muted);
      background: transparent;
      border: 1px solid transparent;
    }

    .btn-icon:hover {
      color: var(--text);
      background: var(--btn-sec-bg);
      border-color: var(--border);
    }

    /* Search */
    .search-bar {
      width: 100%;
      background: var(--input-bg);
      border: 1px solid var(--input-border);
      color: var(--text);
      font-family: inherit;
      font-size: 12px;
      padding: 7px 10px;
      border-radius: 4px;
      outline: none;
    }

    .search-bar:focus {
      border-color: var(--btn-bg);
    }

    /* Accounts List */
    .accounts-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .account-item {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 12px 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      transition: border-color 120ms ease;
    }

    .account-item:hover {
      border-color: var(--text-muted);
    }

    .account-item.active {
      border-color: var(--btn-bg);
      background: var(--card-bg);
    }

    .item-left {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
      flex: 1;
    }

    .slot-num {
      font-size: 11px;
      font-family: monospace;
      color: var(--text-muted);
      min-width: 16px;
      text-align: right;
    }

    .avatar {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: var(--btn-sec-bg);
      border: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
      flex-shrink: 0;
      overflow: hidden;
    }

    .avatar img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .user-info {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .user-name-line {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .user-email {
      font-weight: 600;
      color: var(--text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-size: 13px;
    }

    .badge-current {
      background: #16a34a;
      color: #ffffff;
      font-size: 11px;
      font-weight: 600;
      padding: 2px 7px;
      border-radius: 6px;
      display: inline-block;
      line-height: 1.3;
      letter-spacing: 0.01em;
    }

    /* Quota info */
    .quota-info {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px 12px;
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 4px;
    }

    .quota-metric {
      display: flex;
      align-items: baseline;
      gap: 4px;
    }

    .quota-val {
      font-weight: 600;
      color: var(--text);
    }

    .quota-val.low {
      color: var(--badge-error);
    }

    .quota-status {
      font-size: 11px;
      color: var(--text-muted);
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .quota-status.syncing {
      color: var(--btn-bg);
      font-weight: 500;
    }

    .quota-status.standby {
      color: var(--text-muted);
    }

    /* Item Right Controls */
    .item-right {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }

    .btn-switch {
      padding: 5px 12px;
      font-weight: 500;
    }

    .btn-delete {
      color: var(--text-muted);
      padding: 5px 8px;
    }

    .btn-delete:hover {
      color: var(--badge-error);
      background: rgba(239, 68, 68, 0.1);
    }

    .btn-delete.confirm-delete {
      color: #ffffff !important;
      background: #dc2626 !important;
      border: 1px solid #ef4444 !important;
      font-size: 11px;
      font-weight: 600;
      padding: 3px 8px;
      border-radius: 4px;
    }

    .btn-delete.confirm-delete:hover {
      background: #b91c1c !important;
    }

    /* Footer */
    .footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-top: 12px;
      border-top: 1px solid var(--border);
      font-size: 11px;
      color: var(--text-muted);
    }

    .kbd-hint {
      display: flex;
      gap: 12px;
    }

    .kbd {
      font-family: monospace;
      background: var(--input-bg);
      border: 1px solid var(--border);
      padding: 1px 4px;
      border-radius: 3px;
      color: var(--text);
    }

    .empty-state {
      padding: 40px 16px;
      text-align: center;
      color: var(--text-muted);
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
    }

    .empty-state p {
      margin-top: 6px;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="modal-container">
    <!-- Header -->
    <div class="header">
      <div class="header-left">
        <span class="title">GraviHop</span>
        <span class="count-label" id="accountCountLabel">Loading...</span>
      </div>

      <div class="header-actions">
        <button class="btn-secondary" id="btnCapture" title="Capture active session in IDE">
          Capture Active
        </button>
        <button class="btn-secondary" id="btnNativeLogin" title="Sign in via IDE native redirect (auto-detected)">
          ⚡ Native Login
        </button>
        <button class="btn-primary" id="btnLogin" title="Authorize via browser with Google account chooser">
          + Add Account
        </button>
        <button class="btn-icon" id="btnRefresh" title="Refresh quotas (R)">
          Refresh
        </button>
        <button class="btn-icon" id="btnClose" title="Close (Esc)">
          ✕
        </button>
      </div>
    </div>

    <!-- Filter input -->
    <input type="text" id="searchInput" class="search-bar" placeholder="Filter accounts by email..." />

    <!-- Accounts List -->
    <div class="accounts-list" id="accountsList">
      <!-- Generated via JS -->
    </div>

    <!-- Footer -->
    <div class="footer">
      <div class="kbd-hint">
        <span><span class="kbd">1-9</span> Switch</span>
        <span><span class="kbd">R</span> Refresh</span>
        <span><span class="kbd">Esc</span> Close</span>
      </div>
      <div>
        <button class="btn-icon" id="btnRestartDaemon" style="padding: 2px 6px; font-size: 11px;">
          Restart Language Server
        </button>
      </div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let accounts = [];
    let activeId = null;

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'state') {
        accounts = msg.accounts || [];
        activeId = msg.activeId || null;
        render();
      }
    });

    function render() {
      const list = document.getElementById('accountsList');
      const query = (document.getElementById('searchInput').value || '').toLowerCase().trim();
      const countLabel = document.getElementById('accountCountLabel');

      countLabel.textContent = accounts.length + ' ' + (accounts.length === 1 ? 'account' : 'accounts');

      const filtered = accounts.filter(a => {
        if (!query) return true;
        return a.email.toLowerCase().includes(query) || (a.name && a.name.toLowerCase().includes(query));
      });

      if (filtered.length === 0) {
        if (accounts.length === 0) {
          list.innerHTML = \`
            <div class="empty-state">
              <strong>No accounts saved</strong>
              <p>Click "Capture Current" to save your active IDE account, or "+ Add Account" to log in with a new one.</p>
            </div>
          \`;
        } else {
          list.innerHTML = \`
            <div class="empty-state">
              <strong>No results</strong>
              <p>No accounts match "\${query}".</p>
            </div>
          \`;
        }
        return;
      }

      list.innerHTML = filtered.map((acc, index) => {
        const isActive = acc.id === activeId;
        const initial = (acc.name || acc.email || 'U')[0].toUpperCase();
        const quota = acc.quota;

        const g5h = quota ? quota.gemini5hPercent : null;
        const gWk = quota ? quota.geminiWeeklyPercent : null;
        const c5h = quota ? quota.claude5hPercent : null;
        const cWk = quota ? quota.claudeWeeklyPercent : null;

        const geminiGroup = quota?.groups?.find(g => g.displayName.includes('Gemini'));
        const gemini5hBucket = geminiGroup?.buckets?.find(b => b.bucketId === 'gemini-5h');
        const claudeGroup = quota?.groups?.find(g => g.displayName.includes('Claude'));
        const claude5hBucket = claudeGroup?.buckets?.find(b => b.bucketId === '3p-5h');

        const gReset = gemini5hBucket?.resetFormatted;
        const cReset = claude5hBucket?.resetFormatted;

        let resetText = '';
        if (c5h !== null && c5h < 20 && cReset) {
          resetText = 'Claude resets in ' + cReset;
        } else if (g5h !== null && g5h < 20 && gReset) {
          resetText = 'Gemini resets in ' + gReset;
        } else if (gReset) {
          resetText = 'Resets in ' + gReset;
        } else if (cReset) {
          resetText = 'Resets in ' + cReset;
        }

        return \`
          <div class="account-item \${isActive ? 'active' : ''}">
            <div class="item-left">
              <span class="slot-num">\${index + 1}</span>
              <div class="avatar">
                \${acc.picture ? \`<img src="\${acc.picture}" alt="" />\` : initial}
              </div>
              <div class="user-info">
                <div class="user-name-line">
                  <span class="user-email">\${acc.email}</span>
                  \${isActive ? \`
                    <span class="badge-current">Current</span>
                  \` : ''}
                </div>
                <div class="quota-info">
                  \${g5h !== null ? \`
                    <span class="quota-metric" title="Gemini 5h: \${g5h}%, Weekly: \${gWk}%">Gemini: <span class="quota-val \${g5h < 15 ? 'low' : ''}">\${g5h}%</span> (5h) • <span class="quota-val \${gWk !== null && gWk < 15 ? 'low' : ''}">\${gWk}%</span> (wk)</span>
                    <span class="quota-metric" title="Claude 5h: \${c5h}%, Weekly: \${cWk}%">Claude: <span class="quota-val \${c5h !== null && c5h < 15 ? 'low' : ''}">\${c5h}%</span> (5h) • <span class="quota-val \${cWk !== null && cWk < 15 ? 'low' : ''}">\${cWk}%</span> (wk)</span>
                    \${resetText ? \`<span>• \${resetText}</span>\` : ''}
                    \${!isActive ? \`<span class="quota-status standby">• Standby</span>\` : ''}
                  \` : \`
                    <span class="quota-status syncing">Syncing live quotas...</span>
                  \`}
                </div>
              </div>
            </div>

            <div class="item-right">
              \${!isActive ? \`
                <button class="btn-primary btn-switch" id="btn-switch-\${acc.id}" onclick="switchAcc('\${acc.id}', this)">
                  Switch
                </button>
              \` : ''}
              <button class="btn-icon btn-delete" id="btn-del-\${acc.id}" title="Remove account" onclick="handleDelete('\${acc.id}', this)">
                ✕
              </button>
            </div>
          </div>
        \`;
      }).join('');
    }

    function switchAcc(id, btn) {
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Switching...';
        btn.style.opacity = '0.7';
      }
      vscode.postMessage({ command: 'switch', accountId: id });
    }

    let pendingDeleteId = null;
    let deleteTimeout = null;

    function handleDelete(id, btn) {
      if (pendingDeleteId === id) {
        clearTimeout(deleteTimeout);
        pendingDeleteId = null;
        if (btn) {
          btn.disabled = true;
          btn.textContent = '...';
        }
        vscode.postMessage({ command: 'delete', accountId: id });
      } else {
        if (deleteTimeout) clearTimeout(deleteTimeout);
        document.querySelectorAll('.btn-delete').forEach(b => {
          b.textContent = '✕';
          b.classList.remove('confirm-delete');
        });

        pendingDeleteId = id;
        if (btn) {
          btn.textContent = 'Remove?';
          btn.classList.add('confirm-delete');
        }

        deleteTimeout = setTimeout(() => {
          if (pendingDeleteId === id) {
            pendingDeleteId = null;
            if (btn) {
              btn.textContent = '✕';
              btn.classList.remove('confirm-delete');
            }
          }
        }, 3500);
      }
    }

    document.getElementById('btnClose').addEventListener('click', () => {
      vscode.postMessage({ command: 'close' });
    });

    document.getElementById('btnRefresh').addEventListener('click', () => {
      vscode.postMessage({ command: 'refresh' });
    });

    document.getElementById('btnCapture').addEventListener('click', () => {
      vscode.postMessage({ command: 'capture' });
    });

    document.getElementById('btnNativeLogin').addEventListener('click', () => {
      vscode.postMessage({ command: 'nativeLogin' });
    });

    document.getElementById('btnLogin').addEventListener('click', () => {
      vscode.postMessage({ command: 'login' });
    });

    document.getElementById('btnRestartDaemon').addEventListener('click', () => {
      vscode.postMessage({ command: 'restartLS' });
    });

    document.getElementById('searchInput').addEventListener('input', () => {
      render();
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        vscode.postMessage({ command: 'close' });
      } else if (e.key.toLowerCase() === 'r' && !e.ctrlKey && !e.metaKey && document.activeElement.tagName !== 'INPUT') {
        vscode.postMessage({ command: 'refresh' });
      } else if (['1', '2', '3', '4', '5', '6', '7', '8', '9'].includes(e.key) && document.activeElement.tagName !== 'INPUT') {
        const idx = parseInt(e.key) - 1;
        if (accounts[idx]) {
          vscode.postMessage({ command: 'switch', accountId: accounts[idx].id });
        }
      }
    });
  </script>
</body>
</html>`;
  }
}
