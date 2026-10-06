import * as vscode from 'vscode';
import { AccountManager, AccountEntry } from '../services/accountManager';
import { CONSTANTS } from '../utils/constants';

export class AccountsWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'gravihop.accountsView';
  private view?: vscode.WebviewView;

  constructor(private readonly extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtmlContent();

    webviewView.onDidDispose(() => {
      this.view = undefined;
    });

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(async (message) => {
      const manager = AccountManager.getInstance();
      switch (message.command) {
        case 'switch':
          if (message.accountId) {
            await manager.switchToAccount(message.accountId);
          }
          break;
        case 'delete':
          if (message.accountId) {
            await manager.removeAccount(message.accountId);
          }
          break;
        case 'capture':
          await manager.captureCurrentAccount(true);
          break;
        case 'login':
          await manager.loginWithGoogleBrowser();
          break;
        case 'nativeLogin':
          await vscode.commands.executeCommand('gravihop.loginNative');
          break;
        case 'refresh':
          await manager.refreshActiveQuota();
          break;
        case 'heal':
          await manager.autoHealAuthState(true);
          vscode.window.showInformationMessage('GraviHop: Session healed and synchronized!');
          break;
      }
    });

    // Update whenever accounts change
    AccountManager.getInstance().onDidChangeAccounts(() => {
      this.updateContent();
    });

    this.updateContent();
  }

  public updateContent(): void {
    if (!this.view) {
      return;
    }
    try {
      const manager = AccountManager.getInstance();
      const accounts = manager.getAccounts();
      const activeAccount = manager.getActiveAccount();

      this.view.webview.postMessage({
        type: 'state',
        accounts,
        activeId: activeAccount?.id || null,
      });
    } catch {
      this.view = undefined;
    }
  }

  private getHtmlContent(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GraviHop Accounts</title>
  <style>
    :root {
      --bg: var(--vscode-sideBar-background, #18181b);
      --card-bg: var(--vscode-editor-background, #1f1f23);
      --border: var(--vscode-widget-border, rgba(255, 255, 255, 0.08));
      --text: var(--vscode-foreground, #e4e4e7);
      --text-muted: var(--vscode-descriptionForeground, #a1a1aa);
      --accent: var(--vscode-button-background, #3b82f6);
      --accent-hover: var(--vscode-button-hoverBackground, #2563eb);
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      padding: 12px;
      user-select: none;
    }

    .header-panel {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 14px;
      padding-bottom: 10px;
      border-bottom: 1px solid var(--border);
    }

    .pool-badge {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      color: var(--text-muted);
    }

    .header-actions {
      display: flex;
      gap: 6px;
    }

    .icon-btn {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 4px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      transition: all 0.15s ease;
    }

    .icon-btn:hover {
      background: rgba(255, 255, 255, 0.12);
    }

    .accounts-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .account-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      transition: border-color 0.2s ease, transform 0.1s ease;
      position: relative;
      overflow: hidden;
    }

    .account-card.active {
      border-color: rgba(16, 185, 129, 0.5);
      box-shadow: 0 0 12px rgba(16, 185, 129, 0.08);
    }

    .active-strip {
      position: absolute;
      top: 0;
      left: 0;
      width: 3px;
      height: 100%;
      background: var(--success);
      display: none;
    }

    .account-card.active .active-strip {
      display: block;
    }

    .card-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 10px;
    }

    .avatar {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.1);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 600;
      font-size: 13px;
      color: #fff;
      overflow: hidden;
      flex-shrink: 0;
    }

    .avatar img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .user-info {
      flex: 1;
      min-width: 0;
    }

    .user-name {
      font-weight: 600;
      font-size: 13px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .badge-current {
      background: #16a34a;
      color: #ffffff;
      font-size: 10px;
      font-weight: 600;
      padding: 1px 6px;
      border-radius: 4px;
      display: inline-block;
      line-height: 1.3;
      letter-spacing: 0.01em;
    }

    .user-email {
      font-size: 11px;
      color: var(--text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .quotas-container {
      display: flex;
      flex-direction: column;
      gap: 7px;
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid var(--border);
    }

    .quota-row {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .quota-labels {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
    }

    .quota-title {
      color: var(--text-muted);
    }

    .quota-val {
      font-weight: 600;
    }

    .progress-bar-bg {
      height: 5px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 3px;
      overflow: hidden;
    }

    .progress-bar-fill {
      height: 100%;
      border-radius: 3px;
      transition: width 0.3s ease;
    }

    .card-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: 12px;
      gap: 8px;
    }

    .switch-btn {
      flex: 1;
      padding: 6px 12px;
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }

    .switch-btn:hover:not(:disabled) {
      background: var(--accent-hover);
    }

    .switch-btn:disabled {
      opacity: 0.5;
      cursor: default;
    }

    .del-btn {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-muted);
      padding: 6px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      transition: all 0.15s ease;
    }

    .del-btn:hover {
      color: var(--danger);
      border-color: rgba(239, 68, 68, 0.4);
      background: rgba(239, 68, 68, 0.1);
    }

    .del-btn.confirm-del {
      color: #ffffff !important;
      background: var(--danger) !important;
      border-color: var(--danger) !important;
      font-size: 11px;
      font-weight: 600;
      padding: 4px 6px;
    }

    .empty-state {
      text-align: center;
      padding: 30px 10px;
      color: var(--text-muted);
    }

    .empty-state p {
      margin-bottom: 12px;
    }
  </style>
</head>
<body>
  <div class="header-panel">
    <span class="pool-badge" id="poolCount">0 Accounts</span>
    <div class="header-actions">
      <button class="icon-btn" onclick="captureAccount()" title="Capture current IDE session">+ Capture</button>
      <button class="icon-btn" onclick="nativeLogin()" title="Antigravity Native Browser Login">⚡ Native</button>
      <button class="icon-btn" onclick="loginAccount()" title="Direct Browser Login (with Account Selector)">🌐 Browser</button>
      <button class="icon-btn" onclick="refreshQuotas()" title="Refresh Quotas">↻</button>
    </div>
  </div>

  <div class="accounts-list" id="accountsList"></div>

  <script>
    const vscode = acquireVsCodeApi();

    function captureAccount() {
      vscode.postMessage({ command: 'capture' });
    }

    function nativeLogin() {
      vscode.postMessage({ command: 'nativeLogin' });
    }

    function loginAccount() {
      vscode.postMessage({ command: 'login' });
    }

    function refreshQuotas() {
      vscode.postMessage({ command: 'refresh' });
    }

    function switchAccount(id) {
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
        document.querySelectorAll('.del-btn').forEach(b => {
          b.textContent = '✕';
          b.classList.remove('confirm-del');
        });

        pendingDeleteId = id;
        if (btn) {
          btn.textContent = 'Remove?';
          btn.classList.add('confirm-del');
        }

        deleteTimeout = setTimeout(() => {
          if (pendingDeleteId === id) {
            pendingDeleteId = null;
            if (btn) {
              btn.textContent = '✕';
              btn.classList.remove('confirm-del');
            }
          }
        }, 3500);
      }
    }

    function getBarColor(pct) {
      if (pct < 10) return 'var(--danger)';
      if (pct <= 25) return 'var(--warning)';
      return 'var(--success)';
    }

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'state') {
        render(msg.accounts || [], msg.activeId);
      }
    });

    function render(accounts, activeId) {
      const container = document.getElementById('accountsList');
      const poolCount = document.getElementById('poolCount');
      poolCount.textContent = accounts.length + (accounts.length === 1 ? ' Account' : ' Accounts');

      if (accounts.length === 0) {
        container.innerHTML = \`
          <div class="empty-state">
            <p>No accounts in pool yet.</p>
            <button class="switch-btn" onclick="captureAccount()">Save Current Account</button>
          </div>
        \`;
        return;
      }

      container.innerHTML = accounts.map(acc => {
        const isActive = acc.id === activeId;
        const initial = (acc.name || acc.email || 'U')[0].toUpperCase();
        const avatarHtml = acc.picture
          ? \`<img src="\${acc.picture}" alt="\${acc.name}">\`
          : initial;

        const q = acc.quota;
        const g5h = q ? q.gemini5hPercent : 100;
        const gWk = q ? q.geminiWeeklyPercent : 100;
        const c5h = q ? q.claude5hPercent : 100;

        const geminiGroup = q?.groups?.find(g => g.displayName.includes('Gemini'));
        const b5h = geminiGroup?.buckets?.find(b => b.bucketId === 'gemini-5h');
        const resetStr = b5h?.resetFormatted ? \` • Reset in \${b5h.resetFormatted}\` : '';

        return \`
          <div class="account-card \${isActive ? 'active' : ''}">
            <div class="active-strip"></div>
            <div class="card-header">
              <div class="avatar">\${avatarHtml}</div>
              <div class="user-info">
                <div class="user-name">
                  \${acc.name || acc.email.split('@')[0]}
                  \${isActive ? '<span class="badge-current">Current</span>' : ''}
                </div>
                <div class="user-email" title="\${acc.email}">\${acc.email}</div>
              </div>
            </div>

            <div class="quotas-container">
              <div class="quota-row">
                <div class="quota-labels">
                  <span class="quota-title">⚡ Gemini 5h\${resetStr}</span>
                  <span class="quota-val" style="color: \${getBarColor(g5h)}">\${g5h}%</span>
                </div>
                <div class="progress-bar-bg">
                  <div class="progress-bar-fill" style="width: \${g5h}%; background: \${getBarColor(g5h)}"></div>
                </div>
              </div>

              <div class="quota-row">
                <div class="quota-labels">
                  <span class="quota-title">📅 Gemini Weekly</span>
                  <span class="quota-val" style="color: \${getBarColor(gWk)}">\${gWk}%</span>
                </div>
                <div class="progress-bar-bg">
                  <div class="progress-bar-fill" style="width: \${gWk}%; background: \${getBarColor(gWk)}"></div>
                </div>
              </div>

              <div class="quota-row">
                <div class="quota-labels">
                  <span class="quota-title">🤖 Claude & GPT</span>
                  <span class="quota-val" style="color: \${getBarColor(c5h)}">\${c5h}%</span>
                </div>
                <div class="progress-bar-bg">
                  <div class="progress-bar-fill" style="width: \${c5h}%; background: \${getBarColor(c5h)}"></div>
                </div>
              </div>
            </div>

            <div class="card-actions">
              <button class="switch-btn" \${isActive ? 'disabled' : ''} onclick="switchAccount('\${acc.id}')">
                \${isActive ? 'Active Now' : 'Switch to Account'}
              </button>
              <button class="del-btn" id="del-btn-\${acc.id}" title="Remove from pool" onclick="handleDelete('\${acc.id}', this)">✕</button>
            </div>
          </div>
        \`;
      }).join('');
    }
  </script>
</body>
</html>`;
  }
}
