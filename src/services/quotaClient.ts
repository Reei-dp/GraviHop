import * as http from 'http';
import { execFile } from 'child_process';
import { promisify } from 'util';

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
      const candidates: { pid: string; csrfToken: string }[] = [];

      for (const line of psOut.split('\n')) {
        if (line.includes('language_server') && line.includes('--csrf_token')) {
          const match = line.match(/--csrf_token\s+([a-f0-9\-]+)/);
          if (match) {
            const pid = line.trim().split(/\s+/)[0];
            candidates.push({ pid, csrfToken: match[1] });
          }
        }
      }

      if (candidates.length === 0) {
        return null;
      }

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

  private static probePort(port: number, csrfToken: string): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-codeium-csrf-token': csrfToken,
          },
          timeout: 1000,
        },
        (res) => {
          resolve(res.statusCode === 200);
        }
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      req.write('{}');
      req.end();
    });
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

    return new Promise((resolve) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-codeium-csrf-token': csrfToken,
          },
          timeout: 3000,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            if (res.statusCode === 200) {
              try {
                const parsed = JSON.parse(data);
                const rawGroups = parsed?.response?.groups || [];

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

                resolve({
                  geminiWeeklyPercent,
                  gemini5hPercent,
                  claudeWeeklyPercent,
                  claude5hPercent,
                  groups,
                  lastUpdated: Date.now(),
                });
              } catch (e) {
                console.error('[GraviHop] Failed to parse quota JSON:', e);
                resolve(null);
              }
            } else {
              resolve(null);
            }
          });
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
}
