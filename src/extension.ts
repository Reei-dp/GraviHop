import * as vscode from 'vscode';
import { AccountManager } from './services/accountManager';
import { StatusBarManager } from './ui/statusBar';
import { QuickPickManager } from './ui/quickPick';
import { AccountsWebviewProvider } from './ui/webviewView';
import { HubPanel } from './ui/hubPanel';

let pollingTimer: NodeJS.Timeout | null = null;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('[GraviHop] Extension activating...');

  // 1. Initialize core services
  const accountManager = AccountManager.initialize(context);
  const statusBar = new StatusBarManager();
  const webviewProvider = new AccountsWebviewProvider(context.extensionUri);

  context.subscriptions.push(statusBar);

  // 2. Register Webview View
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      AccountsWebviewProvider.viewType,
      webviewProvider
    )
  );

  // 3. Register Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('gravihop.selectAccount', () => {
      HubPanel.toggle(context.extensionUri);
    }),
    vscode.commands.registerCommand('gravihop.openHub', () => {
      HubPanel.show(context.extensionUri);
    }),
    vscode.commands.registerCommand('gravihop.selectAccountQuickPick', async () => {
      await QuickPickManager.showAccountMenu();
    }),
    vscode.commands.registerCommand('gravihop.refreshQuotas', async () => {
      await accountManager.refreshActiveQuota();
      vscode.window.showInformationMessage('GraviHop: Quotas updated.');
    }),
    vscode.commands.registerCommand('gravihop.captureCurrentAccount', async () => {
      await accountManager.captureCurrentAccount(true);
    }),
    vscode.commands.registerCommand('gravihop.addAccount', async () => {
      await accountManager.loginWithGoogleBrowser();
    }),
    vscode.commands.registerCommand('gravihop.openDashboard', () => {
      HubPanel.show(context.extensionUri);
    }),
    vscode.commands.registerCommand('gravihop.healSession', async () => {
      await accountManager.autoHealAuthState(true);
      vscode.window.showInformationMessage('GraviHop: Active session healed and synced to Antigravity!');
    }),
    vscode.commands.registerCommand('gravihop.loginNative', async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'GraviHop: Antigravity Native Login',
          cancellable: true,
        },
        async (progress, cancellationToken) => {
          progress.report({ message: 'Opening Google authentication in browser...' });

          const prevToken = await accountManager.getLiveAccessToken();

          try {
            await vscode.commands.executeCommand('workbench.action.loginWithRedirect');
          } catch {
            await vscode.commands.executeCommand('antigravity.login');
          }

          progress.report({ message: 'Waiting for sign-in in browser... (choose your account)' });

          const startTime = Date.now();
          const maxWaitMs = 120000; // 2 minutes

          while (!cancellationToken.isCancellationRequested && Date.now() - startTime < maxWaitMs) {
            await new Promise((r) => setTimeout(r, 1500));

            const currentToken = await accountManager.getLiveAccessToken();
            if (currentToken && currentToken !== prevToken) {
              progress.report({ message: 'New session detected! Capturing account...' });
              const captured = await accountManager.captureCurrentAccount(true);
              if (captured) {
                return;
              }
            }
          }

          if (!cancellationToken.isCancellationRequested) {
            vscode.window
              .showInformationMessage(
                'GraviHop: Finished browser login? Click to capture new account.',
                'Capture Session'
              )
              .then((choice) => {
                if (choice === 'Capture Session') {
                  accountManager.captureCurrentAccount(true);
                }
              });
          }
        }
      );
    })
  );

  // 4. React to account changes
  accountManager.onDidChangeAccounts((accounts) => {
    const active = accountManager.getActiveAccount();
    statusBar.update(active, accounts.length);
    webviewProvider.updateContent();
    if (HubPanel.currentPanel) {
      HubPanel.currentPanel.updateContent();
    }
  });

  // 5. Initial account load & auto-healing
  const initialAccounts = await accountManager.load();
  const initialActive = accountManager.getActiveAccount();
  statusBar.update(initialActive, initialAccounts.length);
  await accountManager.autoHealAuthState();
  accountManager.refreshAllQuotas().catch((e) => console.warn('[GraviHop] Initial quotas refresh:', e));

  // 6. Listen for Unified State Sync topic changes (auto-capture native logins & session updates)
  const agySync = (vscode as any).antigravityUnifiedStateSync;
  if (agySync && typeof agySync.subscribe === 'function') {
    try {
      const oauthSub = await agySync.subscribe('uss-oauth');
      if (oauthSub && oauthSub.onDidChange) {
        let topicTimer: NodeJS.Timeout | null = null;
        context.subscriptions.push(
          oauthSub.onDidChange(() => {
            if (topicTimer) clearTimeout(topicTimer);
            topicTimer = setTimeout(async () => {
              await accountManager.onAgyAuthTopicChanged();
            }, 1200);
          })
        );
        console.log('[GraviHop] Subscribed to native uss-oauth topic changes.');
      }
    } catch (e) {
      console.warn('[GraviHop] Failed to subscribe to uss-oauth:', e);
    }
  }

  // Fallback: Listen for standard VS Code Auth session changes
  context.subscriptions.push(
    vscode.authentication.onDidChangeSessions(async () => {
      const config = vscode.workspace.getConfiguration('gravihop');
      if (config.get<boolean>('autoCaptureOnSessionChange', true)) {
        setTimeout(async () => {
          await accountManager.onAgyAuthTopicChanged();
        }, 1200);
      }
    })
  );

  // 7. Start background polling & smart quota exhaustion alert
  setupBackgroundPolling(accountManager);

  console.log('[GraviHop] Extension activated successfully.');
}

function setupBackgroundPolling(accountManager: AccountManager): void {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }

  const config = vscode.workspace.getConfiguration('gravihop');
  const intervalMinutes = config.get<number>('autoRefreshIntervalMinutes', 10);
  if (intervalMinutes <= 0) {
    return;
  }

  const ms = intervalMinutes * 60 * 1000;
  pollingTimer = setInterval(async () => {
    try {
      const quota = await accountManager.refreshActiveQuota();
      if (!quota) {
        return;
      }

      const active = accountManager.getActiveAccount();
      if (!active) {
        return;
      }

      const threshold = config.get<number>('lowQuotaWarningThreshold', 10);
      const isLow =
        quota.gemini5hPercent <= threshold || quota.geminiWeeklyPercent <= threshold;

      if (isLow) {
        // Find best alternative account in pool
        const candidates = accountManager
          .getAccounts()
          .filter((a) => a.id !== active.id)
          .sort((a, b) => {
            const qA = a.quota?.gemini5hPercent || 0;
            const qB = b.quota?.gemini5hPercent || 0;
            return qB - qA;
          });

        const best = candidates[0];
        if (best && (best.quota?.gemini5hPercent || 0) > threshold) {
          const geminiAvailable = best.quota?.gemini5hPercent || 100;
          const choice = await vscode.window.showWarningMessage(
            `⚠️ Quota low on ${active.email} (${quota.gemini5hPercent}% left). Switch to ${best.email} (${geminiAvailable}% available)?`,
            'Switch Now',
            'Remind Later'
          );

          if (choice === 'Switch Now') {
            await accountManager.switchToAccount(best.id);
          }
        }
      }
    } catch (e) {
      console.warn('[GraviHop] Background polling error:', e);
    }
  }, ms);
}

export function deactivate(): void {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}
