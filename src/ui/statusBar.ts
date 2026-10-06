import * as vscode from 'vscode';
import { AccountEntry } from '../services/accountManager';

export class StatusBarManager implements vscode.Disposable {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'gravihop.selectAccount';
    this.item.show();
  }

  public update(activeAccount: AccountEntry | null, accountsCount: number): void {
    if (!activeAccount) {
      this.item.text = '$(organization) GraviHop: No Account';
      this.item.tooltip = 'Click to configure accounts';
      this.item.backgroundColor = undefined;
      return;
    }

    const quota = activeAccount.quota;
    const nameOrEmail = activeAccount.name || activeAccount.email.split('@')[0];

    if (!quota) {
      this.item.text = `$(organization) ${nameOrEmail} (${accountsCount})`;
      this.item.tooltip = new vscode.MarkdownString(
        `**GraviHop: ${activeAccount.email}**\n\nClick to switch account or refresh quotas.`
      );
      this.item.backgroundColor = undefined;
      return;
    }

    const g5h = quota.gemini5hPercent;
    const gWeekly = quota.geminiWeeklyPercent;
    const c5h = quota.claude5hPercent;

    let icon = '🟢';
    let bg: vscode.ThemeColor | undefined = undefined;

    if (g5h < 10 || gWeekly < 10) {
      icon = '🔴';
      bg = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (g5h <= 25 || gWeekly <= 25) {
      icon = '🟡';
      bg = new vscode.ThemeColor('statusBarItem.warningBackground');
    }

    this.item.text = `${icon} ${nameOrEmail}: ⚡ ${g5h}% | 🤖 ${c5h}%`;
    this.item.backgroundColor = bg;

    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.appendMarkdown(`### GraviHop — Account Status\n\n`);
    md.appendMarkdown(`**Account:** \`${activeAccount.email}\` (${activeAccount.tier || 'Standard'})\n\n`);
    md.appendMarkdown(`---\n\n`);
    md.appendMarkdown(`**Gemini Models:**\n`);
    md.appendMarkdown(`- 5-Hour Quota: **${g5h}%**\n`);
    md.appendMarkdown(`- Weekly Quota: **${gWeekly}%**\n\n`);
    md.appendMarkdown(`**Claude & GPT Models:**\n`);
    md.appendMarkdown(`- 5-Hour Quota: **${c5h}%**\n\n`);
    md.appendMarkdown(`---\n\n`);
    md.appendMarkdown(`*Click or press \`Ctrl+Shift+C\` to open GraviHop Hub.*`);

    this.item.tooltip = md;
  }

  public dispose(): void {
    this.item.dispose();
  }
}
