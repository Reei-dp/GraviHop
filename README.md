<div align="center">

# GraviHop

### Multi-account pool manager & zero-downtime quota hopper for Antigravity IDE

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Linux%20%7C%20macOS%20%7C%20Windows-blueviolet?style=flat-square)]()
[![Target](https://img.shields.io/badge/IDE-Antigravity%20IDE-orange?style=flat-square)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-3178C6?style=flat-square&logo=typescript&logoColor=white)]()

<br />

```text
 ── [1] dev@gmail.com       ⚡ Gemini: 12% | 🤖 3P: 25%   [Exhausted]
 ── [2] team@gmail.com      ⚡ Gemini: 98% | 🤖 3P: 100%  [Active]    ◄── Hopped in 1.2s
 ── [3] backup@gmail.com    ⚡ Gemini: 85% | 🤖 3P: 90%   [Standby]
```

</div>

---

## Why GraviHop?

Antigravity IDE limits you to a single active Google identity at any given time. When you hit the 5-hour or weekly model quotas on Flash, Pro, or Claude, the only native workaround is logging out, opening an external browser, and doing the Google OAuth dance all over again.

**GraviHop eliminates that loop.** It keeps your authorized Google accounts in an encrypted local pool, monitors real-time quota telemetry in the background, and hot-swaps active sessions directly inside SQLite in **1 click** without restarting your editor window.

---

## Features

- **1-Click Instant Hop (`Ctrl + Shift + C`)**  
  Select any account from the QuickPick menu or sidebar. GraviHop atomically patches the credentials in `state.vscdb`, issues an internal restart signal to the language server, and re-attaches within 1–2 seconds.

- **Real-Time Quota Telemetry**  
  Directly taps into the local Language Server RPC (`/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`) to display exact remaining percentages and reset countdowns for:
  - **Gemini Models:** 5-hour burst window (`gemini-5h`) & weekly volume (`gemini-weekly`).
  - **Claude & GPT Models:** 5-hour window (`3p-5h`) & weekly volume (`3p-weekly`).

- **Hands-Off Auto-Capture**  
  Authenticate through Google in your browser once. GraviHop automatically captures the incoming session tokens from `state.vscdb`, extracts profile metadata, and saves the account slot permanently.

- **Background Token Refresh**  
  Stored accounts are kept alive using Google's OAuth token endpoint (`oauth2.googleapis.com/token`) using Antigravity's native desktop client credentials.

- **Smart Quota Alerts**  
  When your active account dips below a configurable threshold (e.g., `< 10%`), a non-intrusive prompt suggests the highest-capacity standby account in your pool:
  > *⚠️ Quota low on dev@gmail.com (8% left). Switch to team@gmail.com (98% available)?*  
  > `[ Switch Now ]` `[ Remind Later ]`

- **Safety & Rollbacks**  
  Every database write automatically creates a rotating snapshot (`state.vscdb.backup.<timestamp>`), preserving up to 5 historical revisions. All refresh tokens are stored inside VS Code's encrypted `SecretStorage` (OS Keyring / Secret Service).

---

## Interface

### 1. Hub Control Center (`Ctrl + Shift + C`)
A dedicated floating Command Center window with dark glassmorphism, instant 1-click controls, and telemetry gauges:
- **Instant Hop Controls**: Click `Hop to Account` or press `[1-9]` on your keyboard to instantly swap sessions in ~1.2s.
- **Dual Telemetry Gauges**: Real-time progress bars for Gemini (5h + weekly) and Claude / 3P models with reset countdown chips (`⏱ 3h 14m`).
- **Quick Action Bar**: `+ Add Google Account` (browser OAuth), `📥 Capture IDE Account`, `↻ Refresh Telemetry`, and `⚡ Restart Language Server`.
- **Engine & Diagnostics Tab**: Deep inspect active Connect-RPC daemon status, CSRF token state, SQLite paths, and rotating backups.
- **Instant Toggle & Dismiss**: Press `Ctrl + Shift + C` to toggle, or hit `Esc` to instantly return to your code.

### 2. Status Bar Item
Located in the bottom tray of your status bar:
- `🟢 Riyo: ⚡ 88% | 🤖 100%` — Normal capacity (> 25%)
- `🟡 Riyo: ⚡ 18% | 🤖 45%` — Getting low (10% – 25%)
- `🔴 Riyo: ⚡ 4% | 🤖 0%` — Depleted (< 10%)

Hovering over the status bar item displays a breakdown tooltip with reset timers. Clicking it opens the Hub Control Center.

### 3. Lightweight QuickPick Menu (`gravihop.selectAccountQuickPick`)
For users who prefer a minimal dropdown palette:
- Filter accounts directly with fuzzy search
- Displays active account, slot number, and remaining percentages
- Accessible from Command Palette or inside the Hub header (`▾` button)

### 4. Activity Bar Sidebar
A persistent side panel view inside the editor activity bar with account cards and quota trackers.

---

## Keyboard Shortcuts

| Shortcut | Action | Scope |
| :--- | :--- | :--- |
| `Ctrl + Shift + C` (`Cmd + Shift + C`) | Toggle GraviHop Hub Control Center | Global |
| `1` – `9` *(inside Hub)* | Instant Hop to Account Slot 1–9 | Hub Window |
| `R` *(inside Hub)* | Refresh Real-Time Quotas | Hub Window |
| `Esc` *(inside Hub)* | Dismiss & Close Hub | Hub Window |

---

## Configuration

Customizable via VS Code Settings (`Ctrl + ,` -> search `GraviHop`):

```json
{
  // Background interval in minutes for polling quota telemetry (0 to disable)
  "gravihop.autoRefreshIntervalMinutes": 10,

  // Threshold percentage to trigger the low-quota switch suggestion
  "gravihop.lowQuotaWarningThreshold": 10,

  // Automatically add newly authorized browser accounts to the pool
  "gravihop.autoCaptureOnSessionChange": true
}
```

---

## Architecture

```text
┌────────────────┐        1. Read / Patch         ┌────────────────────────┐
│    GraviHop    │ ─────────────────────────────► │      state.vscdb       │
│   Extension    │ ◄───────────────────────────── │    (SQLite Storage)    │
└───────┬────────┘        (Atomic + Backup)       └────────────────────────┘
        │
        │ 2. Restart Trigger (RPC)
        ▼
┌────────────────────────────────┐
│   antigravity.restartLS        │
└───────────────┬────────────────┘
                │
                │ 3. Hot Reload (< 2s)
                ▼
┌────────────────────────────────┐   RetrieveUserQuotaSummary   ┌───────────────────────┐
│ language_server_linux_x64      │ ◄─────────────────────────── │  Local Connect-RPC    │
│ (Active Context: Account #2)   │ ───────────────────────────► │  (Port & CSRF probe)  │
└────────────────────────────────┘                              └───────────────────────┘
```

1. **State Persistence**: SQLite record `antigravityUnifiedStateSync.oauthToken` holds a Protobuf binary payload containing the active OAuth tokens.
2. **Re-encoding Engine**: `ProtobufHelper` packs the updated access token, refresh token, and expiration timestamp with zero third-party C++ bindings.
3. **Language Server Reload**: Calling `antigravity.restartLanguageServer` restarts the background Go daemon, picking up the modified SQLite state within ~1.5s without reloading the renderer window.
4. **Local Telemetry Scraping**: Queries the active local connect-RPC endpoint using the runtime `x-codeium-csrf-token` discovery mechanism.

---

## Build from Source

### Prerequisites
- Node.js `20.x` or higher
- npm `10.x` or higher

```bash
# Clone the repository
git clone https://github.com/Reei-dp/GraviHop.git
cd GraviHop

# Install dependencies
npm install

# Build extension bundle
npm run build

# Package into .vsix
npm run package

# Install directly into Antigravity IDE
antigravity-ide --install-extension gravihop-0.1.0.vsix
```

---

## License

[MIT](LICENSE) © [Reei](https://github.com/Reei-dp)