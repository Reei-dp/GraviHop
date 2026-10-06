import * as vscode from 'vscode';
import { CONSTANTS } from '../utils/constants';
import { ProtobufHelper } from '../utils/protobufHelper';
import { DbWatcher } from './dbWatcher';
import { GoogleAuthService } from './googleAuth';
import { QuotaClient, QuotaSummary } from './quotaClient';

export interface AccountEntry {
  id: string;
  email: string;
  name: string;
  picture?: string;
  tier?: string;
  refreshToken: string;
  accessToken: string;
  expiryDateSeconds: number;
  rawUserStatusB64?: string;
  quota?: QuotaSummary;
  lastCapturedAt: number;
}

export class AccountManager {
  private static instance: AccountManager;
  private secretStorage: vscode.SecretStorage;
  private globalState: vscode.Memento;
  private _onDidChangeAccounts = new vscode.EventEmitter<AccountEntry[]>();
  public readonly onDidChangeAccounts = this._onDidChangeAccounts.event;

  private accountsCache: AccountEntry[] = [];
  private activeAccountId: string | null = null;

  private constructor(context: vscode.ExtensionContext) {
    this.secretStorage = context.secrets;
    this.globalState = context.globalState;
  }

  public static initialize(context: vscode.ExtensionContext): AccountManager {
    if (!this.instance) {
      this.instance = new AccountManager(context);
    }
    return this.instance;
  }

  public static getInstance(): AccountManager {
    if (!this.instance) {
      throw new Error('AccountManager not initialized');
    }
    return this.instance;
  }

  public async load(): Promise<AccountEntry[]> {
    try {
      const raw = await this.secretStorage.get(CONSTANTS.STORAGE_KEYS.ACCOUNTS_POOL);
      if (raw) {
        this.accountsCache = JSON.parse(raw);
      } else {
        const fallbackRaw = this.globalState.get<string>(CONSTANTS.STORAGE_KEYS.ACCOUNTS_POOL);
        this.accountsCache = fallbackRaw ? JSON.parse(fallbackRaw) : [];
      }
    } catch (e) {
      console.warn('[GraviHop] SecretStorage error, using fallback globalState:', e);
      const fallbackRaw = this.globalState.get<string>(CONSTANTS.STORAGE_KEYS.ACCOUNTS_POOL);
      this.accountsCache = fallbackRaw ? JSON.parse(fallbackRaw) : [];
    }

    this.activeAccountId = this.globalState.get<string>(CONSTANTS.STORAGE_KEYS.ACTIVE_ACCOUNT_ID) || null;

    // Automatically capture active account if pool is empty
    if (this.accountsCache.length === 0) {
      await this.captureCurrentAccount(false);
    }

    return this.accountsCache;
  }

  public getAccounts(): AccountEntry[] {
    return this.accountsCache;
  }

  public getActiveAccount(): AccountEntry | null {
    if (!this.activeAccountId && this.accountsCache.length > 0) {
      return this.accountsCache[0];
    }
    return this.accountsCache.find((a) => a.id === this.activeAccountId) || null;
  }

  private async persistAccounts(): Promise<void> {
    try {
      await this.secretStorage.store(
        CONSTANTS.STORAGE_KEYS.ACCOUNTS_POOL,
        JSON.stringify(this.accountsCache)
      );
    } catch (e) {
      console.warn('[GraviHop] SecretStorage store failed, using globalState fallback:', e);
    }

    // Always keep safe mirror in globalState
    await this.globalState.update(
      CONSTANTS.STORAGE_KEYS.ACCOUNTS_POOL,
      JSON.stringify(this.accountsCache)
    );

    this._onDidChangeAccounts.fire(this.accountsCache);
  }

  public async setActiveAccountId(id: string): Promise<void> {
    this.activeAccountId = id;
    await this.globalState.update(CONSTANTS.STORAGE_KEYS.ACTIVE_ACCOUNT_ID, id);
    this._onDidChangeAccounts.fire(this.accountsCache);
  }

  /**
   * Captures the account currently active in state.vscdb
   */
  public async captureCurrentAccount(showNotification = true): Promise<AccountEntry | null> {
    try {
      const oauthRaw = await DbWatcher.getActiveOAuthTokenRaw();
      const userStatusRaw = await DbWatcher.getActiveUserStatusRaw();

      if (!oauthRaw) {
        if (showNotification) {
          vscode.window.showWarningMessage('No active Google session found in Antigravity IDE.');
        }
        return null;
      }

      const decodedToken = ProtobufHelper.decodeOAuthToken(oauthRaw);
      if (!decodedToken || !decodedToken.refreshToken) {
        if (showNotification) {
          vscode.window.showErrorMessage('Could not extract refresh token from active session.');
        }
        return null;
      }

      let email = '';
      let name = '';
      let tier = 'standard-tier';
      let picture = '';

      if (userStatusRaw) {
        const decodedStatus = ProtobufHelper.decodeUserStatus(userStatusRaw);
        email = decodedStatus.email;
        name = decodedStatus.name;
        tier = decodedStatus.userTier || tier;
        picture = decodedStatus.profilePictureUrl || '';
      }

      // Try Google UserInfo API if details are missing
      if (!email || !picture) {
        const profile = await GoogleAuthService.fetchUserProfile(decodedToken.accessToken);
        if (profile) {
          email = email || profile.email;
          name = name || profile.name;
          picture = picture || profile.picture || '';
        }
      }

      if (!email) {
        email = `account_${this.accountsCache.length + 1}@antigravity`;
        name = `Account #${this.accountsCache.length + 1}`;
      }

      const id = email.toLowerCase();
      const existingIdx = this.accountsCache.findIndex((a) => a.id === id);

      // Fetch active quota
      const quota = await QuotaClient.fetchActiveQuota();

      const entry: AccountEntry = {
        id,
        email,
        name: name || email.split('@')[0],
        picture,
        tier,
        refreshToken: decodedToken.refreshToken,
        accessToken: decodedToken.accessToken,
        expiryDateSeconds: decodedToken.expiryDateSeconds,
        rawUserStatusB64: userStatusRaw || undefined,
        quota: quota || undefined,
        lastCapturedAt: Date.now(),
      };

      if (existingIdx >= 0) {
        this.accountsCache[existingIdx] = {
          ...this.accountsCache[existingIdx],
          ...entry,
        };
      } else {
        this.accountsCache.push(entry);
      }

      await this.setActiveAccountId(id);
      await this.persistAccounts();

      if (showNotification) {
        vscode.window.showInformationMessage(
          `GraviHop: Saved account ${email} (Slot ${existingIdx >= 0 ? existingIdx + 1 : this.accountsCache.length}/${this.accountsCache.length})`
        );
      }

      return entry;
    } catch (err) {
      console.error('[GraviHop] Failed to capture active account:', err);
      if (showNotification) {
        vscode.window.showErrorMessage(`Failed to capture account: ${err}`);
      }
      return null;
    }
  }

  /**
   * Switches IDE to target account in 1-click
   */
  public async switchToAccount(id: string): Promise<boolean> {
    const target = this.accountsCache.find((a) => a.id === id);
    if (!target) {
      vscode.window.showErrorMessage(`Account ${id} not found in pool.`);
      return false;
    }

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `GraviHop: Switching to ${target.email}...`,
        cancellable: false,
      },
      async (progress) => {
        try {
          progress.report({ increment: 20, message: 'Checking token validity...' });

          // 1. Refresh token if expired or about to expire in next 5 minutes
          const nowSec = Math.floor(Date.now() / 1000);
          if (!target.accessToken || nowSec + 300 >= target.expiryDateSeconds) {
            progress.report({ increment: 20, message: 'Refreshing Google Access Token...' });
            const refreshRes = await GoogleAuthService.refreshAccessToken(target.refreshToken);
            target.accessToken = refreshRes.accessToken;
            target.expiryDateSeconds = refreshRes.expiryDateSeconds;
            await this.persistAccounts();
          }

          progress.report({ increment: 30, message: 'Updating state.vscdb...' });

          // 2. Re-encode OAuth token protobuf
          const newOAuthB64 = ProtobufHelper.encodeOAuthToken({
            accessToken: target.accessToken,
            refreshToken: target.refreshToken,
            expiryDateSeconds: target.expiryDateSeconds,
          });

          // 3. Write into state.vscdb
          await DbWatcher.applySession(newOAuthB64, target.rawUserStatusB64);
          await this.setActiveAccountId(target.id);

          progress.report({ increment: 20, message: 'Restarting Language Server...' });

          // 4. Trigger Language Server restart
          try {
            await vscode.commands.executeCommand(CONSTANTS.COMMANDS.RESTART_LS);
          } catch (e) {
            console.warn('[GraviHop] restartLanguageServer command warning:', e);
          }

          // 5. Brief wait for LS startup, then fetch fresh quota
          await new Promise((resolve) => setTimeout(resolve, 1500));
          const freshQuota = await QuotaClient.fetchActiveQuota();
          if (freshQuota) {
            target.quota = freshQuota;
            await this.persistAccounts();
          }

          progress.report({ increment: 10, message: 'Switched successfully!' });
          vscode.window.showInformationMessage(`GraviHop: Switched to ${target.email}`);
          return true;
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to switch account: ${err}`);
          return false;
        }
      }
    );
  }

  public async removeAccount(id: string): Promise<void> {
    const account = this.accountsCache.find((a) => a.id === id);
    if (!account) {
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `Remove account ${account.email} from GraviHop pool?`,
      { modal: true },
      'Remove'
    );

    if (confirm === 'Remove') {
      this.accountsCache = this.accountsCache.filter((a) => a.id !== id);
      if (this.activeAccountId === id) {
        this.activeAccountId = this.accountsCache[0]?.id || null;
        await this.globalState.update(CONSTANTS.STORAGE_KEYS.ACTIVE_ACCOUNT_ID, this.activeAccountId);
      }
      await this.persistAccounts();
      vscode.window.showInformationMessage(`Removed ${account.email}`);
    }
  }

  /**
   * Refreshes quota for active account (and updates cached accounts)
   */
  public async refreshActiveQuota(): Promise<QuotaSummary | null> {
    const quota = await QuotaClient.fetchActiveQuota();
    if (quota) {
      const active = this.getActiveAccount();
      if (active) {
        active.quota = quota;
        await this.persistAccounts();
      }
    }
    return quota;
  }
}
