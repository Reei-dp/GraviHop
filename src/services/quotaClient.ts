import * as http from 'http';
import * as https from 'https';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { GoogleAuthService } from './googleAuth';

const execFileAsync = promisify(execFile);

export interface QuotaBucket {
  bucketId: string;
  displayName: string;
  remainingFraction: number;
  remainingPercent: number;
  resetTime?: string;
  resetFormatted?: string;
}

export interface QuotaGroup {
  displayName: string;
  description?: string;
  buckets: QuotaBucket[];
}

export interface QuotaSummary {
  geminiWeeklyPercent: number;
  gemini5hPercent: number;
  claudeWeeklyPercent: number;
  claude5hPercent: number;
  groups: QuotaGroup[];
  lastUpdated: number;
}

export class QuotaClient {
  private static cachedPort: number | null = null;
  private static cachedCsrfToken: string | null = null;
  private static cachedUseHttps = true;

  public static invalidateCache(): void {
    this.cachedPort = null;
    this.cachedCsrfToken = null;
    this.cachedUseHttps = true;
  }

  public static formatCountdown(isoString?: string): string {
    if (!isoString) {
      return '';
    }
    try {
      const target = new Date(isoString).getTime();
      const diffMs = target - Date.now();
      if (diffMs <= 0) {
        return 'Ready';
      }

      const totalMinutes = Math.floor(diffMs / (60 * 1000));
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      const days = Math.floor(hours / 24);

      if (days > 0) {
        const remainingHours = hours % 24;
        return `${days}d ${remainingHours}h`;
      }
      if (hours > 0) {
        return `${hours}h ${minutes}m`;
      }
      return `${minutes}m`;
    } catch {
      return '';
    }
  }

  /**
   * Discovers running language_server instances and probes local HTTP endpoints
   */
  public static async discoverLanguageServer(): Promise<{ port: number; csrfToken: string } | null> {
    try {
      // 1. Find process with --csrf_token
      const { stdout: psOut } = await execFileAsync('ps', ['-eo', 'pid,args']);
      const candidates: { pid: string; csrfToken: string; score: number }[] = [];

      for (const line of psOut.split('\n')) {
        if (line.includes('language_server') && line.includes('--csrf_token')) {
          const match = line.match(/--csrf_token\s+([a-f0-9\-]+)/);
          if (match) {
            const pid = line.trim().split(/\s+/)[0];
            let score = 0;
            // Antigravity IDE language server (subclient_type ide) is top priority
            if (line.includes('--subclient_type ide')) {
              score += 1000;
            }
            if (line.includes('antigravity-ide')) {
              score += 500;
            }
            if (line.includes('language_server_linux')) {
              score += 200;
            }
            if (line.includes('cloudcode-pa')) {
              score += 100;
            }
            // Strongly penalize standalone / hub / external CLI processes
            if (line.includes('--standalone')) {
              score -= 1000;
            }
            if (line.includes('--subclient_type hub')) {
              score -= 1000;
            }
            if (line.includes('/opt/Antigravity/')) {
              score -= 1000;
            }
            candidates.push({ pid, csrfToken: match[1], score });
          }
        }
      }

      if (candidates.length === 0) {
        return null;
      }

      // Prioritize Antigravity IDE language server over standalone/hub daemons
      candidates.sort((a, b) => b.score - a.score);

      // 2. Discover open ports via ss -tulpn
      const { stdout: ssOut } = await execFileAsync('ss', ['-tulpn']);

      for (const { pid, csrfToken } of candidates) {
        for (const line of ssOut.split('\n')) {
          if (line.includes(`pid=${pid},`) && line.includes('127.0.0.1:')) {
            const portMatch = line.match(/127\.0\.0\.1:(\d+)/);
            if (portMatch) {
              const port = parseInt(portMatch[1], 10);
              const isWorking = await this.probePort(port, csrfToken);
              if (isWorking) {
                this.cachedPort = port;
                this.cachedCsrfToken = csrfToken;
                return { port, csrfToken };
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn('[GraviHop] Language server discovery failed:', err);
    }

    return null;
  }

  private static sendQuotaRequest(
    port: number,
    csrfToken: string,
    useHttps: boolean,
    timeoutMs = 1500
  ): Promise<{ statusCode?: number; data: string } | null> {
    const mod = useHttps ? (https as any) : (http as any);
    return new Promise((resolve) => {
      const req = mod.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-codeium-csrf-token': csrfToken,
          },
          timeout: timeoutMs,
          rejectUnauthorized: false,
        },
        (res: http.IncomingMessage) => {
          let data = '';
          res.on('data', (chunk: Buffer | string) => (data += chunk));
          res.on('end', () => resolve({ statusCode: res.statusCode, data }));
        }
      );
      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      req.write('{}');
      req.end();
    });
  }

  private static async probePort(port: number, csrfToken: string): Promise<boolean> {
    // Try HTTPS first (Antigravity IDE language server uses HTTPS)
    const resHttps = await this.sendQuotaRequest(port, csrfToken, true, 1200);
    if (resHttps?.statusCode === 200) {
      this.cachedUseHttps = true;
      return true;
    }
    // Fallback to plain HTTP
    const resHttp = await this.sendQuotaRequest(port, csrfToken, false, 1200);
    if (resHttp?.statusCode === 200) {
      this.cachedUseHttps = false;
      return true;
    }
    return false;
  }

  /**
   * Fetches real-time quota from active local language server
   */
  public static async fetchActiveQuota(): Promise<QuotaSummary | null> {
    let port = this.cachedPort;
    let csrfToken = this.cachedCsrfToken;

    if (!port || !csrfToken || !(await this.probePort(port, csrfToken))) {
      const discovered = await this.discoverLanguageServer();
      if (!discovered) {
        return null;
      }
      port = discovered.port;
      csrfToken = discovered.csrfToken;
    }

    let resp = await this.sendQuotaRequest(port, csrfToken, this.cachedUseHttps, 3000);
    if (!resp || resp.statusCode !== 200) {
      // Try toggle protocol
      this.cachedUseHttps = !this.cachedUseHttps;
      resp = await this.sendQuotaRequest(port, csrfToken, this.cachedUseHttps, 3000);
    }

    if (!resp || resp.statusCode !== 200) {
      return null;
    }

    try {
      const parsed = JSON.parse(resp.data);
      return this.parseQuotaPayload(parsed);
    } catch (e) {
      console.error('[GraviHop] Failed to parse local quota JSON:', e);
      return null;
    }
  }

  /**
   * Universal parser for Quota JSON payloads (supports both local Language Server and Google Cloud Code API)
   */
  public static parseQuotaPayload(parsed: any): QuotaSummary | null {
    const rawGroups = parsed?.response?.groups || parsed?.groups || [];
    if (!rawGroups || rawGroups.length === 0) {
      return null;
    }

    let geminiWeeklyPercent = 100;
    let gemini5hPercent = 100;
    let claudeWeeklyPercent = 100;
    let claude5hPercent = 100;

    const groups: QuotaGroup[] = rawGroups.map((g: any) => {
      const buckets: QuotaBucket[] = (g.buckets || []).map((b: any) => {
        const fraction = typeof b.remainingFraction === 'number' ? b.remainingFraction : 1.0;
        const percent = Math.round(fraction * 100);

        if (b.bucketId === 'gemini-weekly') {
          geminiWeeklyPercent = percent;
        } else if (b.bucketId === 'gemini-5h') {
          gemini5hPercent = percent;
        } else if (b.bucketId === '3p-weekly') {
          claudeWeeklyPercent = percent;
        } else if (b.bucketId === '3p-5h') {
          claude5hPercent = percent;
        }

        return {
          bucketId: b.bucketId || '',
          displayName: b.displayName || '',
          remainingFraction: fraction,
          remainingPercent: percent,
          resetTime: b.resetTime,
          resetFormatted: QuotaClient.formatCountdown(b.resetTime),
        };
      });

      return {
        displayName: g.displayName || '',
        description: g.description || '',
        buckets,
      };
    });

    return {
      geminiWeeklyPercent,
      gemini5hPercent,
      claudeWeeklyPercent,
      claude5hPercent,
      groups,
      lastUpdated: Date.now(),
    };
  }

  /**
   * Fetches real-time quota for ANY account directly via Google Cloud Code endpoints.
   * If token is expired or unauthorized, automatically refreshes with refreshToken.
   */
  public static async fetchQuotaForAccount(
    accessToken: string,
    refreshToken?: string
  ): Promise<{ quota: QuotaSummary; refreshedToken?: { accessToken: string; expiryDateSeconds: number } } | null> {
    // 1. Try with current accessToken
    let res = await this.queryGoogleCloudCodeQuota(accessToken);
    if (res) {
      return { quota: res };
    }

    // 2. If failed and refreshToken provided, refresh and retry
    if (refreshToken) {
      try {
        const refreshed = await GoogleAuthService.refreshAccessToken(refreshToken);
        if (refreshed?.accessToken) {
          const retryRes = await this.queryGoogleCloudCodeQuota(refreshed.accessToken);
          if (retryRes) {
            return {
              quota: retryRes,
              refreshedToken: {
                accessToken: refreshed.accessToken,
                expiryDateSeconds: refreshed.expiryDateSeconds,
              },
            };
          }
        }
      } catch (err) {
        console.warn('[GraviHop] Token refresh during quota fetch failed:', err);
      }
    }

    return null;
  }

  private static async queryGoogleCloudCodeQuota(accessToken: string): Promise<QuotaSummary | null> {
    const endpoints = [
      'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
      'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
    ];

    for (const ep of endpoints) {
      try {
        const u = new URL(ep);
        const data = await new Promise<string | null>((resolve) => {
          const req = https.request(
            {
              hostname: u.hostname,
              path: u.pathname,
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'User-Agent': 'antigravity',
              },
              timeout: 4000,
            },
            (res) => {
              if (res.statusCode !== 200) {
                resolve(null);
                return;
              }
              let body = '';
              res.on('data', (chunk) => (body += chunk));
              res.on('end', () => resolve(body));
            }
          );
          req.on('error', () => resolve(null));
          req.on('timeout', () => {
            req.destroy();
            resolve(null);
          });
          req.write('{}');
          req.end();
        });

        if (data) {
          const parsed = JSON.parse(data);
          const summary = this.parseQuotaPayload(parsed);
          if (summary) {
            return summary;
          }
        }
      } catch {}
    }
    return null;
  }

  /**
   * Fetches active quota with automatic invalidation and exponential/poll retry.
   * Crucial after language server restarts.
   */
  public static async fetchActiveQuotaWithRetry(
    maxAttempts = 5,
    delayMs = 1200
  ): Promise<QuotaSummary | null> {
    this.invalidateCache();
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const quota = await this.fetchActiveQuota();
      if (quota) {
        return quota;
      }
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return null;
  }
}
