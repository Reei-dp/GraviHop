import * as vscode from 'vscode';
import { AccountManager, AccountEntry } from '../services/accountManager';
import { CONSTANTS } from '../utils/constants';

interface AccountQuickPickItem extends vscode.QuickPickItem {
  accountId?: string;
  action?: 'capture' | 'login' | 'refresh' | 'dashboard';
}

export class QuickPickManager {
  public static async showAccountMenu(): Promise<void> {
    const manager = AccountManager.getInstance();
    const accounts = manager.getAccounts();
    const activeAccount = manager.getActiveAccount();

    const items: AccountQuickPickItem[] = [];

    // 1. Account entries
    if (accounts.length > 0) {
      items.push({
        label: 'SWITCH ACCOUNT',
        kind: vscode.QuickPickItemKind.Separator,
      });

      accounts.forEach((acc, idx) => {
        const isActive = activeAccount?.id === acc.id;
        const prefix = isActive ? '✓ ' : '   ';
        const num = `[${idx + 1}]`;

        let quotaDetails = 'Quotas pending...';
        let detail = '';

        if (acc.quota) {
          const g5h = acc.quota.gemini5hPercent;
          const c5h = acc.quota.claude5hPercent;

          const geminiGroup = acc.quota.groups.find((g) => g.displayName.includes('Gemini'));
          const bucket5h = geminiGroup?.buckets.find((b) => b.bucketId === 'gemini-5h');
          const resetText = bucket5h?.resetFormatted ? ` • Reset: ${bucket5h.resetFormatted}` : '';

          quotaDetails = `⚡ Gemini: ${g5h}% | 🤖 3P: ${c5h}%${resetText}`;
        }

        if (isActive) {
          detail = `★ Currently active in Antigravity IDE (${acc.tier || 'Standard'})`;
        } else {
          detail = `Click to switch to this account`;
        }

        items.push({
          label: `${prefix}${num} ${acc.email}`,
          description: quotaDetails,
          detail,
          accountId: acc.id,
        });
      });
    }

    // 2. Action items
    items.push({
      label: 'ACTIONS',
      kind: vscode.QuickPickItemKind.Separator,
    });

    items.push({
      label: '$(add) Save / Capture Current Account',
      description: 'Add the currently active IDE account to GraviHop pool',
      action: 'capture',
    });

    items.push({
      label: '$(browser) Log In with New Account...',
      description: 'Open browser to authenticate another Google account',
      action: 'login',
    });

    items.push({
      label: '$(refresh) Refresh Quotas',
      description: 'Update real-time quotas for accounts',
      action: 'refresh',
    });

    items.push({
      label: '$(dashboard) Open Dashboard Panel',
      description: 'Open full cards view in sidebar',
      action: 'dashboard',
    });

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select an account to switch or manage pool (Ctrl+Shift+C)',
      matchOnDescription: true,
      matchOnDetail: true,
    });

    if (!selected) {
      return;
    }

    if (selected.accountId) {
      if (activeAccount?.id === selected.accountId) {
        vscode.window.showInformationMessage(`Account ${selected.accountId} is already active.`);
        return;
      }
      await manager.switchToAccount(selected.accountId);
    } else if (selected.action) {
      switch (selected.action) {
        case 'capture':
          await manager.captureCurrentAccount(true);
          break;
        case 'login':
          await vscode.commands.executeCommand(CONSTANTS.COMMANDS.LOGIN);
          break;
        case 'refresh':
          await manager.refreshActiveQuota();
          vscode.window.showInformationMessage('GraviHop: Quotas refreshed.');
          break;
        case 'dashboard':
          await vscode.commands.executeCommand('gravihop.accountsView.focus');
          break;
      }
    }
  }
}
