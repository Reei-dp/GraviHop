import * as vscode from 'vscode';
import * as http from 'http';
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
    let pool: AccountEntry[] = [];
    try {
      const raw = await this.secretStorage.get(CONSTANTS.STORAGE_KEYS.ACCOUNTS_POOL);
      if (raw) {
        pool = JSON.parse(raw);
      }
    } catch (e) {
      console.warn('[GraviHop] SecretStorage error, using fallback globalState:', e);
    }

    const fallbackRaw = this.globalState.get<string>(CONSTANTS.STORAGE_KEYS.ACCOUNTS_POOL);
    if (fallbackRaw) {
      try {
        const fallbackList: AccountEntry[] = JSON.parse(fallbackRaw);
        if (pool.length === 0) {
          pool = fallbackList;
        } else {
          // Merge to ensure accounts are never dropped
          for (const fb of fallbackList) {
            if (!pool.some((a) => a.id === fb.id)) {
              pool.push(fb);
            }
          }
        }
      } catch {}
    }

    this.accountsCache = pool;
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

  private isSwitchingOrLogging = false;

  /**
   * Reads OAuth token info directly from Antigravity Unified State Sync in-memory store
   */
  public async getInMemoryOAuthToken(): Promise<{
    accessToken: string;
    refreshToken: string;
    expiryDateSeconds: number;
    tokenType?: string;
  } | null> {
    try {
      const agySync = (vscode as any).antigravityUnifiedStateSync;
      if (agySync?.OAuthPreferences?.getOAuthTokenInfo) {
        const tokenInfo = await agySync.OAuthPreferences.getOAuthTokenInfo();
        if (tokenInfo && tokenInfo.accessToken) {
          return {
            accessToken: tokenInfo.accessToken,
            refreshToken: tokenInfo.refreshToken || '',
            expiryDateSeconds: tokenInfo.expiryDateSeconds || 0,
            tokenType: tokenInfo.tokenType || 'Bearer',
          };
        }
      }
    } catch (e) {
      console.warn('[GraviHop] getInMemoryOAuthToken error:', e);
    }
    return null;
  }

  /**
   * Reads UserStatus protobuf directly from Antigravity Unified State Sync in-memory store
   */
  public async getInMemoryUserStatus(): Promise<string | null> {
    try {
      const agySync = (vscode as any).antigravityUnifiedStateSync;
      if (agySync?.UserStatus?.getUserStatus) {
        const status = await agySync.UserStatus.getUserStatus();
        if (status && typeof status === 'string' && status.length > 0) {
          return status;
        }
      }
    } catch (e) {
      console.warn('[GraviHop] getInMemoryUserStatus error:', e);
    }
    return null;
  }

  /**
   * Returns current active accessToken (in-memory first, then SQLite disk)
   */
  public async getLiveAccessToken(): Promise<string | null> {
    const inMem = await this.getInMemoryOAuthToken();
    if (inMem?.accessToken) {
      return inMem.accessToken;
    }
    const raw = await DbWatcher.getActiveOAuthTokenRaw();
    if (raw) {
      const decoded = ProtobufHelper.decodeOAuthToken(raw);
      return decoded?.accessToken || null;
    }
    return null;
  }

  /**
   * Captures the account currently active in Antigravity (memory first, then disk).
   * Automatically adds as a new slot if it's a different Google account.
   */
  public async captureCurrentAccount(showNotification = true): Promise<AccountEntry | null> {
    try {
      // 1. Get tokens: in-memory first, fallback to SQLite disk
      const inMemToken = await this.getInMemoryOAuthToken();
      let accessToken = inMemToken?.accessToken || '';
      let refreshToken = inMemToken?.refreshToken || '';
      let expiryDateSeconds = inMemToken?.expiryDateSeconds || 0;

      if (!accessToken || !refreshToken) {
        const oauthRaw = await DbWatcher.getActiveOAuthTokenRaw();
        if (oauthRaw) {
          const decodedToken = ProtobufHelper.decodeOAuthToken(oauthRaw);
          if (decodedToken) {
            accessToken = decodedToken.accessToken || accessToken;
            refreshToken = decodedToken.refreshToken || refreshToken;
            expiryDateSeconds = decodedToken.expiryDateSeconds || expiryDateSeconds;
          }
        }
      }

      if (!accessToken && !refreshToken) {
        if (showNotification) {
          vscode.window.showWarningMessage('No active Google session found in Antigravity IDE.');
        }
        return null;
      }

      // 2. Get user status: in-memory first, fallback to SQLite disk
      let userStatusRaw = (await this.getInMemoryUserStatus()) || (await DbWatcher.getActiveUserStatusRaw()) || undefined;

      let email = '';
      let name = '';
      let tier = 'standard-tier';
      let picture = '';

      if (userStatusRaw) {
        try {
          const decodedStatus = ProtobufHelper.decodeUserStatus(userStatusRaw);
          email = decodedStatus.email || '';
          name = decodedStatus.name || '';
          tier = decodedStatus.userTier || tier;
          picture = decodedStatus.profilePictureUrl || '';
        } catch {}
      }

      // 3. Always verify live Google profile directly from Google API using accessToken
      if (accessToken) {
        try {
          const profile = await GoogleAuthService.fetchUserProfile(accessToken);
          if (profile) {
            email = profile.email || email;
            name = profile.name || name;
            picture = profile.picture || picture;
          }
        } catch (e) {
          console.warn('[GraviHop] Google profile fetch failed during capture:', e);
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

      // Ensure models catalog is preserved
      let finalUserStatusB64 = userStatusRaw;
      const donor = this.accountsCache.find((a) => a.rawUserStatusB64 && a.rawUserStatusB64.length > 0)?.rawUserStatusB64;
      if (!finalUserStatusB64 && donor) {
        finalUserStatusB64 = donor;
      }
      if (finalUserStatusB64) {
        const patched = ProtobufHelper.patchUserStatus(finalUserStatusB64, email, name, picture);
        finalUserStatusB64 = patched.topicB64;
      }

      const entry: AccountEntry = {
        id,
        email,
        name: name || email.split('@')[0],
        picture,
        tier,
        refreshToken: refreshToken || (existingIdx >= 0 ? this.accountsCache[existingIdx].refreshToken : ''),
        accessToken,
        expiryDateSeconds,
        rawUserStatusB64: finalUserStatusB64 || (existingIdx >= 0 ? this.accountsCache[existingIdx].rawUserStatusB64 : undefined),
        quota: quota || undefined,
        lastCapturedAt: Date.now(),
      };

      const isNew = existingIdx < 0;
      if (isNew) {
        this.accountsCache.push(entry);
      } else {
        this.accountsCache[existingIdx] = {
          ...this.accountsCache[existingIdx],
          ...entry,
        };
      }

      await this.setActiveAccountId(id);
      await this.persistAccounts();
      this._onDidChangeAccounts.fire(this.accountsCache);

      if (showNotification) {
        if (isNew) {
          vscode.window.showInformationMessage(
            `GraviHop: Captured new account ${email} (Slot ${this.accountsCache.length}/${this.accountsCache.length})! 🎉`
          );
        } else {
          vscode.window.showInformationMessage(
            `GraviHop: Saved account ${email} (Slot ${existingIdx + 1}/${this.accountsCache.length})`
          );
        }
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
   * Called when Antigravity's native uss-oauth topic changes in memory.
   * Auto-detects if a different account signed in.
   */
  public async onAgyAuthTopicChanged(): Promise<void> {
    if (this.isSwitchingOrLogging) {
      return;
    }

    try {
      const inMemToken = await this.getInMemoryOAuthToken();
      if (!inMemToken?.accessToken) {
        console.log('[GraviHop] USS reported empty/signedOut token. Respecting sign-out.');
        return;
      }

      const profile = await GoogleAuthService.fetchUserProfile(inMemToken.accessToken);
      if (!profile?.email) {
        return;
      }

      const currentEmail = profile.email.toLowerCase();
      if (currentEmail !== this.activeAccountId) {
        console.log(`[GraviHop] Auto-detect: Antigravity session changed to ${currentEmail}! Auto-capturing...`);
        await this.captureCurrentAccount(true);
      }
    } catch (e) {
      console.warn('[GraviHop] onAgyAuthTopicChanged error:', e);
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

    this.isSwitchingOrLogging = true;
    try {
      return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `GraviHop: Switching to ${target.email}...`,
        cancellable: false,
      },
      async (progress) => {
        try {
          progress.report({ increment: 15, message: 'Checking token validity...' });

          // 1. Refresh token if expired or about to expire in next 5 minutes
          const nowSec = Math.floor(Date.now() / 1000);
          if (!target.accessToken || nowSec + 300 >= target.expiryDateSeconds) {
            progress.report({ increment: 15, message: 'Refreshing Google Access Token...' });
            const refreshRes = await GoogleAuthService.refreshAccessToken(target.refreshToken);
            target.accessToken = refreshRes.accessToken;
            target.expiryDateSeconds = refreshRes.expiryDateSeconds;
            await this.persistAccounts();
          }

          progress.report({ increment: 20, message: 'Updating session credentials...' });

          // Ensure valid userStatus with target email & name (never wipe IDE model catalog and tiers)
          const donor =
            target.rawUserStatusB64 ||
            this.accountsCache.find((a) => a.rawUserStatusB64 && a.rawUserStatusB64.length > 0)?.rawUserStatusB64 ||
            (await DbWatcher.getActiveUserStatusRaw());
          if (donor) {
            const patched = ProtobufHelper.patchUserStatus(
              donor,
              target.email,
              target.name,
              target.picture
            );
            target.rawUserStatusB64 = patched.topicB64;
          }

          // 2. NATIVE UNIFIED STATE SYNC: Update in-memory state in Antigravity IDE
          await this.pushNativeAuthState('signedIn', target);

          // 3. PERSISTENCE: Write into state.vscdb on disk (survives IDE restarts)
          const newOAuthB64 = ProtobufHelper.encodeOAuthToken({
            accessToken: target.accessToken,
            refreshToken: target.refreshToken,
            expiryDateSeconds: target.expiryDateSeconds,
          });
          await DbWatcher.applySession(newOAuthB64, target.rawUserStatusB64);
          await this.setActiveAccountId(target.id);

          progress.report({ increment: 20, message: 'Restarting Language Server...' });

          // 4. Invalidate quota cache & trigger Language Server restart
          QuotaClient.invalidateCache();
          try {
            await vscode.commands.executeCommand(CONSTANTS.COMMANDS.RESTART_LS);
          } catch (e) {
            console.warn('[GraviHop] restartLanguageServer command warning:', e);
          }

          // 5. Wait for Language Server to fully restart and authenticate
          progress.report({ increment: 15, message: 'Waiting for Language Server...' });
          await new Promise((resolve) => setTimeout(resolve, 2000));

          // 6. Sync fresh quota from the now-authenticated LS
          progress.report({ increment: 10, message: 'Syncing live quotas...' });
          const freshQuota = await QuotaClient.fetchActiveQuotaWithRetry(5, 1200);
          if (freshQuota) {
            target.quota = freshQuota;
          }

          await this.persistAccounts();
          this._onDidChangeAccounts.fire(this.accountsCache);

          progress.report({ increment: 5, message: 'Switched successfully!' });
          vscode.window.showInformationMessage(
            `GraviHop: Switched to ${target.email}! Active and ready.`
          );
          return true;
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to switch account: ${err}`);
          return false;
        }
      }
    );
    } finally {
      this.isSwitchingOrLogging = false;
    }
  }

  public async removeAccount(id: string): Promise<void> {
    const account = this.accountsCache.find((a) => a.id === id);
    if (!account) {
      return;
    }

    this.accountsCache = this.accountsCache.filter((a) => a.id !== id);
    if (this.activeAccountId === id) {
      this.activeAccountId = this.accountsCache[0]?.id || null;
      await this.globalState.update(CONSTANTS.STORAGE_KEYS.ACTIVE_ACCOUNT_ID, this.activeAccountId);
      if (this.activeAccountId) {
        await this.switchToAccount(this.activeAccountId);
      }
    }
    await this.persistAccounts();
    this._onDidChangeAccounts.fire(this.accountsCache);
    vscode.window.showInformationMessage(`GraviHop: Removed ${account.email}`);
  }

  /**
   * Pushes in-memory auth state and tokens directly into Antigravity Unified State Sync (USS)
   * This immediately transitions the IDE Chat and agents to signedIn without reload.
   */
  /**
   * Pushes in-memory auth state and tokens directly into Antigravity Unified State Sync (USS)
   * This immediately transitions the IDE Chat and agents to signedIn without reload.
   */
  public async pushNativeAuthState(
    state: 'signedIn' | 'signedOut',
    account?: AccountEntry
  ): Promise<void> {
    const agySync = (vscode as any).antigravityUnifiedStateSync;
    if (!agySync) {
      console.log('[GraviHop] Native unifiedStateSync API not found on vscode module.');
      return;
    }

    try {
      // 1. In-memory OAuth preferences (tokens)
      if (account && agySync.OAuthPreferences?.setOAuthTokenInfo) {
        await agySync.OAuthPreferences.setOAuthTokenInfo({
          accessToken: account.accessToken,
          refreshToken: account.refreshToken,
          expiryDateSeconds: account.expiryDateSeconds || Math.floor(Date.now() / 1000) + 3600,
          tokenType: 'Bearer',
          isGcpTos: false,
        });
        console.log('[GraviHop] Native in-memory OAuthPreferences updated.');
      }

      // 2. In-memory authStateWithContextSentinelKey in uss-oauth topic
      if (agySync.pushUpdate) {
        await agySync.pushUpdate({
          topicName: 'uss-oauth',
          appliedUpdate: {
            key: 'authStateWithContextSentinelKey',
            newRow: {
              value: JSON.stringify({
                state: state,
                context: {
                  project: '',
                  showProjectError: false,
                  errorMessage: '',
                  ineligibleMessage: '',
                  verificationUrl: '',
                  isGcpTos: false,
                  browserOpenFailed: false,
                  appealUrl: '',
                  appealLinkText: '',
                },
              }),
              eTag: 0,
            },
          },
        });
        console.log(`[GraviHop] Native USS authState pushed: ${state}`);
      }

      // 3. In-memory userStatusSentinelKey in uss-userStatus topic (crucial for models & session detection)
      if (account && agySync.pushUpdate) {
        let innerStatus = ProtobufHelper.extractInnerUserStatus(account.rawUserStatusB64);
        if (!innerStatus) {
          const donor = this.accountsCache.find((a) => a.rawUserStatusB64 && a.rawUserStatusB64.length > 0);
          if (donor?.rawUserStatusB64) {
            const patched = ProtobufHelper.patchUserStatus(
              donor.rawUserStatusB64,
              account.email,
              account.name,
              account.picture
            );
            innerStatus = patched.innerB64;
            account.rawUserStatusB64 = patched.topicB64;
          }
        }
        if (innerStatus) {
          await agySync.pushUpdate({
            topicName: 'uss-userStatus',
            appliedUpdate: {
              key: 'userStatusSentinelKey',
              newRow: {
                value: innerStatus,
                eTag: 0,
              },
            },
          });
          console.log('[GraviHop] Native USS userStatus pushed successfully.');
        }
      }

      // 4. Trigger native IDE auth refresh event
      try {
        await vscode.commands.executeCommand('antigravity.handleAuthRefresh');
        console.log('[GraviHop] Executed antigravity.handleAuthRefresh');
      } catch (e) {
        console.warn('[GraviHop] handleAuthRefresh warning:', e);
      }
    } catch (err) {
      console.warn('[GraviHop] pushNativeAuthState warning:', err);
    }
  }

  /**
   * Checks current IDE auth state. If it is in 'loginError' (IDE crash/desync),
   * automatically heals it by syncing the active account credentials.
   * NOTE: Never auto-heals when deliberately signed out.
   */
  public async autoHealAuthState(force = false): Promise<void> {
    try {
      const agySync = (vscode as any).antigravityUnifiedStateSync;
      const active = this.getActiveAccount();
      if (!active) return;

      let needsHeal = force;
      if (!needsHeal && agySync) {
        const currentAuthState = agySync.OAuthPreferences?.getAuthState
          ? await agySync.OAuthPreferences.getAuthState()
          : null;

        // ONLY auto-heal if Antigravity is in an explicit error state, NOT on user logout or normal transition!
        if (currentAuthState === 'loginError') {
          needsHeal = true;
          console.log(
            `[GraviHop] Detected loginError state in Antigravity. Healing with active account ${active.email}...`
          );
        }
      }

      if (needsHeal) {
        await this.pushNativeAuthState('signedIn', active);
        try {
          await vscode.commands.executeCommand(CONSTANTS.COMMANDS.RESTART_LS);
        } catch {}
      }
    } catch (err) {
      console.warn('[GraviHop] autoHealAuthState warning:', err);
    }
  }

  /**
   * Starts a local loopback server, launches browser for Google OAuth,
   * captures incoming code, fetches tokens, and adds account to pool.
   */
  public async loginWithGoogleBrowser(): Promise<AccountEntry | null> {
    return new Promise((resolve) => {
      let server: http.Server | null = null;
      let timeoutId: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (server) {
          try {
            server.close();
          } catch {}
          server = null;
        }
      };

      try {
        server = http.createServer(async (req, res) => {
          try {
            const host = req.headers.host || '127.0.0.1';
            const reqUrl = new URL(req.url || '', `http://${host}`);
            if (reqUrl.pathname === '/oauth-callback') {
              const code = reqUrl.searchParams.get('code');
              const error = reqUrl.searchParams.get('error');

              if (error) {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(`<html><body style="font-family:sans-serif;background:#18181b;color:#ef4444;text-align:center;padding:50px;"><h2>Authorization cancelled</h2><p>${error}</p></body></html>`);
                cleanup();
                resolve(null);
                return;
              }

              if (!code) {
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                res.end('Missing authorization code');
                return;
              }

              // Serve sleek confirmation page
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(`<!DOCTYPE html>
<html>
<head><title>GraviHop Authorized</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;background:#18181b;color:#f4f4f5;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
  <div style="background:#27272a;border:1px solid #3f3f46;border-radius:12px;padding:32px 40px;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,0.5);">
    <div style="font-size:36px;margin-bottom:12px;">✅</div>
    <h2 style="margin:0 0 8px 0;font-size:18px;">Account added to GraviHop!</h2>
    <p style="margin:0;color:#a1a1aa;font-size:13px;">You can now close this tab and return to Antigravity IDE.</p>
  </div>
  <script>setTimeout(() => window.close(), 1500);</script>
</body>
</html>`);

              const address = server?.address();
              const port = typeof address === 'object' && address ? address.port : 0;
              const redirectUri = `http://127.0.0.1:${port}/oauth-callback`;

              cleanup();

              let newlyAdded: AccountEntry | null = null;
              this.isSwitchingOrLogging = true;
              try {
                await vscode.window.withProgress(
                  {
                    location: vscode.ProgressLocation.Notification,
                    title: 'GraviHop: Authorizing new account...',
                    cancellable: false,
                  },
                  async (progress) => {
                    try {
                      progress.report({ increment: 30, message: 'Exchanging authorization code...' });
                      const tokens = await GoogleAuthService.exchangeCodeForTokens(code, redirectUri);
                      progress.report({ increment: 40, message: 'Fetching user profile...' });
                      const profile = await GoogleAuthService.fetchUserProfile(tokens.accessToken);
                      const email = profile?.email || 'unknown@gmail.com';

                      const donor =
                        this.accountsCache.find((a) => a.rawUserStatusB64 && a.rawUserStatusB64.length > 0)?.rawUserStatusB64 ||
                        (await DbWatcher.getActiveUserStatusRaw());
                      let userStatusTopic = donor;
                      if (donor) {
                        const patched = ProtobufHelper.patchUserStatus(
                          donor,
                          email,
                          profile?.name,
                          profile?.picture
                        );
                        userStatusTopic = patched.topicB64;
                      }

                      const newEntry: AccountEntry = {
                        id: email,
                        email: email,
                        name: profile?.name || email.split('@')[0],
                        picture: profile?.picture,
                        refreshToken: tokens.refreshToken,
                        accessToken: tokens.accessToken,
                        expiryDateSeconds: tokens.expiryDateSeconds,
                        rawUserStatusB64: userStatusTopic || undefined,
                        lastCapturedAt: Date.now(),
                      };

                      const existingIdx = this.accountsCache.findIndex((a) => a.id === newEntry.id);
                      if (existingIdx >= 0) {
                        this.accountsCache[existingIdx] = newEntry;
                      } else {
                        this.accountsCache.push(newEntry);
                      }

                      await this.persistAccounts();
                      this._onDidChangeAccounts.fire(this.accountsCache);
                      newlyAdded = newEntry;
                      progress.report({ increment: 30, message: 'Account saved!' });
                    } catch (e: any) {
                      vscode.window.showErrorMessage(`GraviHop OAuth failed: ${e.message}`);
                    }
                  }
                );
              } finally {
                this.isSwitchingOrLogging = false;
              }

              if (newlyAdded) {
                vscode.window.showInformationMessage(
                  `GraviHop: Account ${(newlyAdded as AccountEntry).email} successfully added (Slot ${this.accountsCache.length}/${this.accountsCache.length})!`
                );
                // Switch outside the authorizer progress dialog so notifications don't freeze
                await this.switchToAccount((newlyAdded as AccountEntry).id);
                resolve(newlyAdded);
              } else {
                resolve(null);
              }
            }
          } catch (e) {
            cleanup();
            resolve(null);
          }
        });

        // Listen on random free port on loopback 127.0.0.1
        server.listen(0, '127.0.0.1', async () => {
          const address = server?.address();
          if (!address || typeof address !== 'object') {
            cleanup();
            resolve(null);
            return;
          }

          const port = address.port;
          const redirectUri = `http://127.0.0.1:${port}/oauth-callback`;
          const scopes = encodeURIComponent(CONSTANTS.GOOGLE_OAUTH.SCOPES.join(' '));

          const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${CONSTANTS.GOOGLE_OAUTH.CLIENT_ID}&redirect_uri=${encodeURIComponent(
            redirectUri
          )}&response_type=code&scope=${scopes}&access_type=offline&prompt=select_account%20consent`;

          await vscode.env.openExternal(vscode.Uri.parse(authUrl));

          // 3-minute timeout
          timeoutId = setTimeout(() => {
            cleanup();
            resolve(null);
          }, 180000);
        });

        server.on('error', (err) => {
          cleanup();
          vscode.window.showErrorMessage(`GraviHop OAuth server error: ${err.message}`);
          resolve(null);
        });
      } catch (err: any) {
        cleanup();
        vscode.window.showErrorMessage(`Failed to start login: ${err.message}`);
        resolve(null);
      }
    });
  }

  /**
   * Refreshes quotas for ALL accounts in the pool simultaneously!
   */
  public async refreshAllQuotas(): Promise<void> {
    if (this.accountsCache.length === 0) return;

    QuotaClient.invalidateCache();
    const active = this.getActiveAccount();

    await Promise.allSettled(
      this.accountsCache.map(async (acc) => {
        try {
          // If active account, try local language server first
          if (active && acc.id === active.id) {
            const localQuota = await QuotaClient.fetchActiveQuotaWithRetry(2, 600);
            if (localQuota) {
              acc.quota = localQuota;
              return;
            }
          }

          // Otherwise, fetch directly via Google Cloud Code API
          if (acc.accessToken) {
            const result = await QuotaClient.fetchQuotaForAccount(acc.accessToken, acc.refreshToken);
            if (result) {
              acc.quota = result.quota;
              if (result.refreshedToken) {
                acc.accessToken = result.refreshedToken.accessToken;
                acc.expiryDateSeconds = result.refreshedToken.expiryDateSeconds;
              }
            }
          }
        } catch (e) {
          console.warn(`[GraviHop] Failed to fetch quota for ${acc.email}:`, e);
        }
      })
    );

    await this.persistAccounts();
    this._onDidChangeAccounts.fire(this.accountsCache);
  }

  /**
   * Refreshes quotas for active account and all accounts in pool
   */
  public async refreshActiveQuota(): Promise<QuotaSummary | null> {
    await this.refreshAllQuotas();
    return this.getActiveAccount()?.quota || null;
  }
}
