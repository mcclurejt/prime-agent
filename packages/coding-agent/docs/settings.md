# Settings

Prime Agent uses JSON settings files with project settings overriding global settings.

| Location | Scope |
|----------|-------|
| `~/.prime/agent/settings.json` | Global (all projects) |
| `.prime/agent/settings.json` | Project (current directory) |

Edit directly or use `/settings` for common options.

## All Settings

### Model & Thinking

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `defaultProvider` | string | - | Default provider (e.g., `"anthropic"`, `"openai"`) |
| `defaultModel` | string | - | Default model ID |
| `defaultThinkingLevel` | string | `"xhigh"` | `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"` |
| `hideThinkingBlock` | boolean | `false` | Hide thinking blocks in output |
| `thinkingBudgets` | object | - | Custom token budgets per thinking level |

#### thinkingBudgets

```json
{
  "thinkingBudgets": {
    "minimal": 1024,
    "low": 4096,
    "medium": 10240,
    "high": 32768
  }
}
```

#### sessionSummary

`sessionSummary` is a global daemon setting; project settings do not override it. Summaries are opt-in: set both `provider` and `model` to enable recap and Needs Input classification. Changes take effect after restarting the daemon.

```json
{
  "sessionSummary": {
    "provider": "openai-codex",
    "model": "gpt-5.6-luna",
    "workingIntervalMs": 25000
  }
}
```

`workingIntervalMs` defaults to `25000` and has a minimum of `10000` milliseconds.

### UI & Display

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `theme` | string | `"dark"` | Theme name (`"dark"`, `"light"`, or custom) |
| `quietStartup` | boolean | `false` | Hide startup header |
| `collapseChangelog` | boolean | `false` | Show condensed changelog after updates |
| `treeFilterMode` | string | `"user-only"` | Default filter for `/tree`: `"default"`, `"no-tools"`, `"user-only"`, `"labeled-only"`, `"all"` |
| `editorPaddingX` | number | `0` | Horizontal padding for input editor (0-3) |
| `autocompleteMaxVisible` | number | `5` | Max visible items in autocomplete dropdown (3-20) |
| `showHardwareCursor` | boolean | `false` | Show terminal cursor |

### Update Checks

Stable builds fetch the release manifest at `https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/latest.json`. Beta builds fetch `beta.json` and continue following beta updates. Override the base URL with `PRIME_AGENT_DOWNLOAD_BASE_URL`.

Set `PI_SKIP_VERSION_CHECK=1` to disable the Prime Agent version update check. Use `--offline` or `PI_OFFLINE=1` to disable startup network operations, including update checks and package update checks.

The stable `latest.json` and beta `beta.json` manifests use the same JSON shape:

```json
{
  "version": "0.73.1",
  "package": "prime-agent",
  "tarball": "releases/v0.73.1/prime-agent-0.73.1.tgz"
}
```

`version` is required. `package` is optional and may also be named `packageName`; it defaults to the current package name. `tarball` is optional; when present, Prime Agent installs that tarball instead of the package name. Relative tarball paths resolve against `PRIME_AGENT_DOWNLOAD_BASE_URL`.

### Warnings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `warnings.anthropicExtraUsage` | boolean | `true` | Show a warning when Anthropic subscription auth may use paid extra usage |

```json
{
  "warnings": {
    "anthropicExtraUsage": false
  }
}
```

### Compaction

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `compaction.enabled` | boolean | `true` | Enable auto-compaction |
| `compaction.reserveTokens` | number | `16384` | Tokens reserved for LLM response |
| `compaction.keepRecentTokens` | number | `20000` | Recent tokens to keep (not summarized) |

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

### Branch Summary

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `branchSummary.reserveTokens` | number | `16384` | Tokens reserved for branch summarization |
| `branchSummary.skipPrompt` | boolean | `false` | Skip "Summarize branch?" prompt on `/tree` navigation (defaults to no summary) |

### Retry

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `retry.enabled` | boolean | `true` | Enable automatic agent-level retry on transient errors |
| `retry.maxRetries` | number | `3` | Maximum agent-level retry attempts |
| `retry.baseDelayMs` | number | `2000` | Base delay for agent-level exponential backoff (2s, 4s, 8s) |
| `retry.provider.timeoutMs` | number | SDK default | Provider/SDK request timeout in milliseconds |
| `retry.provider.maxRetries` | number | SDK default | Provider/SDK retry attempts |
| `retry.provider.maxRetryDelayMs` | number | `60000` | Max server-requested delay before failing (60s) |

When a provider requests a retry delay longer than `retry.provider.maxRetryDelayMs` (e.g., Google's "quota will reset after 5h"), the request fails immediately with an informative error instead of waiting silently. Set to `0` to disable the cap.

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000,
    "provider": {
      "timeoutMs": 3600000,
      "maxRetries": 0,
      "maxRetryDelayMs": 60000
    }
  }
}
```

### Amazon Bedrock

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `bedrock.autoSsoRefresh` | boolean | `true` | Run `aws sso login` automatically when the AWS SSO session behind Bedrock or Bedrock Mantle expires, then retry the turn |

A sign-in starts after a request fails on an expired session, or before a request when the cached
token is stale and its refresh grant is gone (while the grant exists, the AWS SDK refreshes silently).

Requires the AWS CLI on `PATH`. Only SSO-backed profiles are affected: static keys, bearer tokens,
container roles, and IRSA are left alone. One sign-in runs per host (other sessions wait on a lock
file), at most one attempt per 10 minutes per process, with the browser sign-in wait capped at 180s.
See [Providers](providers.md#automatic-aws-sso-refresh).

```json
{
  "bedrock": {
    "autoSsoRefresh": true
  }
}
```

### Message Delivery

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `steeringMode` | string | `"one-at-a-time"` | How steering messages are sent: `"all"` or `"one-at-a-time"` |
| `followUpMode` | string | `"one-at-a-time"` | How follow-up messages are sent: `"all"` or `"one-at-a-time"` |
| `transport` | string | `"sse"` | Preferred transport for providers that support multiple transports: `"sse"`, `"websocket"`, or `"auto"` |

#### remoteQuestionnaire

`remoteQuestionnaire` is an opt-in, global-only interactive setting. It is read only from `~/.prime/agent/settings.json`; project settings cannot enable or override it. It is disabled unless `enabled` is exactly `true`, the recipient is a valid E.164 phone number or conservative Apple-ID email address, and the client is a macOS interactive rich-questionnaire presenter. Invalid settings, unsupported clients, or operational failures leave the terminal questionnaire local and usable.

```json
{
  "remoteQuestionnaire": {
    "enabled": true,
    "recipient": "+15551234567",
    "delayMinutes": 5,
    "linkLifetimeHours": 12,
    "cloudflaredPath": "/opt/homebrew/bin/cloudflared"
  }
}
```

`recipient` is the E.164 iMessage phone number (for example, `+15551234567`) or Apple-ID email address to receive the link. `delayMinutes` defaults to `5`; it is the minimum **continuous** local presentation age before escalation. `linkLifetimeHours` defaults to `12`; it is an absolute wall-clock expiry, including during reconnects, and no later message or link is sent after expiry. Both values must be finite positive numbers. `cloudflaredPath` is optional; when omitted, `cloudflared` is resolved from `PATH`; when supplied, it must be an absolute path without control characters.

Escalation also requires a fixed five-minute system-wide HID idle interval. Normal activity or an unreadable idle value delays escalation without closing the local questionnaire. This feature requires macOS, a signed-in and permitted Messages app/iMessage account, and a separately installed `cloudflared` executable. Prime Agent does not install or configure Messages, iMessage, or `cloudflared`, and Quick Tunnel availability is not guaranteed.

After both timing checks pass, this presenter starts a disposable loopback form and asks `cloudflared` for a Quick Tunnel over HTTP/2 before sending iMessage. Cloudflare TLS is used, but Cloudflare may observe the questionnaire plaintext; do not enable this setting for data you cannot disclose to Cloudflare. Apple may prefetch only the generic, non-secret route; that prefetch does not establish a questionnaire session or consume the fragment secret. Opening the link exchanges the fragment exactly once for one secure browser session; losing that session cookie makes that link unusable.

For each logical questionnaire request, a presenter process sends at most one original iMessage and, after a successful original delivery, at most one changed-host replacement. The in-memory cap remains across `/reload` for that process lifetime; there are no reminders and no persisted logical IDs. The limit is per presenter process: `N` eligible attached presenter processes can independently create `N` tunnels and send up to `N` original messages (and up to `N` qualifying replacements).

The phone supports the rich questionnaire workflow but cannot dismiss it. On a transient terminal reconnect, the phone form is suspended; a re-presentation of the same logical request rebinds its new lease and revision without a new message and preserves phone work. A conflicting answer or note change is reported as stale, lists the exact changed questions, and preserves phone work until the operator explicitly chooses **Reload latest**; reloading replaces the phone draft with the authoritative terminal draft. Local and mobile mutations share the existing compare-and-swap path: exactly one terminal submit wins. A successful phone submit reports **Submitted**, while a local winner reports **Answered elsewhere** on the phone.

Remote delivery is best-effort. Failures in idle detection, the loopback server, tunnel, Messages, or remote submission do not dismiss the terminal questionnaire or invent an answer. A detached tunnel child is identity-tracked; normal teardown stops it, while an identity-matched orphan after a hard crash is reaped at the next macOS rich interactive presenter startup even if the setting has since been disabled or removed.

### Terminal & Images

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `terminal.showImages` | boolean | `true` | Show image type and dimensions in terminal |
| `terminal.inlineImages` | boolean | `false` | Render live images with a supported terminal graphics protocol when fullscreen mode is off |
| `terminal.clearOnShrink` | boolean | `false` | Clear empty rows when content shrinks (can cause flicker) |
| `images.autoResize` | boolean | `true` | Resize images to 2000x2000 max |
| `images.blockImages` | boolean | `false` | Block all images from being sent to LLM |

Inline terminal graphics are opt-in and apply only to live tool results. Historical session replay remains metadata-only so reopening a session does not retransmit old images. Fullscreen mode also uses metadata because terminal images cannot be safely clipped or repositioned in its scrollable viewport. To display inline images in iTerm2, use:

```json
{
  "terminal": {
    "showImages": true,
    "inlineImages": true,
    "fullscreen": false
  }
}
```

Prime Agent detects iTerm2 automatically from its terminal environment. Kitty, Ghostty, and WezTerm use the Kitty graphics protocol. Inline graphics remain disabled under tmux and GNU Screen, where protocol passthrough is not reliable.

### Shell

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `shellPath` | string | - | Custom shell path (e.g., for Cygwin on Windows) |
| `shellCommandPrefix` | string | - | Prefix for every bash command (e.g., `"shopt -s expand_aliases"`) |
| `npmCommand` | string[] | - | Command argv used for npm package lookup/install operations (e.g., `["mise", "exec", "node@20", "--", "npm"]`) |

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

`npmCommand` is used for all npm package-manager operations, including installs, uninstalls, and dependency installs inside git packages. Use argv-style entries exactly as the process should be launched. When `npmCommand` is configured, git package dependency installs use plain `install` to avoid npm-specific flags in wrappers or alternate package managers.

Normally the package manager's global modules location is queried using `root -g`. As a special case, if the first element of `npmCommand` is `"bun"`, the modules location will instead be queried with `pm bin -g`.

### Daemon

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `idleEvictionMinutes` | number or `"off"` | `90` | Idle threshold in minutes for whole-tree worker eviction and individual idle-child passivation; `"off"` disables both. |

`idleEvictionMinutes` is a global daemon policy and is read only from `~/.prime/agent/settings.json`. Set it to a positive number to configure the idle threshold.

### Sessions

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sessionDir` | string | - | Directory where session files are stored. Accepts absolute or relative paths, plus `~`. |

```json
{ "sessionDir": ".prime/agent/sessions" }
```

When multiple sources specify a session directory, precedence is `--session-dir`, `PRIME_AGENT_SESSION_DIR`, the legacy `PRIME_AGENT_CODING_AGENT_SESSION_DIR`, then `sessionDir` in `settings.json`.

### Model Cycling

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabledModels` | string[] | - | Model patterns for Ctrl+P cycling (same format as `--models` CLI flag) |

```json
{
  "enabledModels": ["claude-*", "gpt-4o", "gemini-2*"]
}
```

### Markdown

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `markdown.codeBlockIndent` | string | `"  "` | Indentation for code blocks |

### Resources

These settings define where to load extensions, skills, prompts, and themes from.

Paths in `~/.prime/agent/settings.json` resolve relative to `~/.prime/agent`. Paths in `.prime/agent/settings.json` resolve relative to `.prime/agent`. Absolute paths and `~` are supported.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `packages` | array | `[]` | npm/git packages to load resources from |
| `extensions` | string[] | `[]` | Local extension file paths or directories |
| `skills` | string[] | `[]` | Local skill file paths or directories |
| `prompts` | string[] | `[]` | Local prompt template paths or directories |
| `themes` | string[] | `[]` | Local theme file paths or directories |
| `enableSkillCommands` | boolean | `true` | Register skills as `/skill:name` commands |
| `enableBuiltinSkills` | boolean | `true` | Load built-in skills shipped with prime-agent |
| `bundledSkills.websearch` | boolean | `true` | Load the built-in `websearch` skill |

Arrays support glob patterns and exclusions. Use `!pattern` to exclude. Use `+path` to force-include an exact path and `-path` to force-exclude an exact path.

Disable the built-in `websearch` skill while keeping normal skill discovery enabled:

```json
{
  "bundledSkills": {
    "websearch": false
  }
}
```

#### packages

String form loads all resources from a package:

```json
{
  "packages": ["pi-skills", "@org/my-extension"]
}
```

Object form filters which resources to load:

```json
{
  "packages": [
    {
      "source": "pi-skills",
      "skills": ["brave-search", "transcribe"],
      "extensions": []
    }
  ]
}
```

See [packages.md](packages.md) for package management details.

## Example

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-20250514",
  "defaultThinkingLevel": "xhigh",
  "theme": "dark",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  },
  "retry": {
    "enabled": true,
    "maxRetries": 3
  },
  "enabledModels": ["claude-*", "gpt-4o"],
  "warnings": {
    "anthropicExtraUsage": true
  },
  "packages": ["pi-skills"]
}
```

## Project Overrides

Project settings (`.prime/agent/settings.json`) override global settings. Nested objects are merged:

```json
// ~/.prime/agent/settings.json (global)
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 16384 }
}

// .prime/agent/settings.json (project)
{
  "compaction": { "reserveTokens": 8192 }
}

// Result
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 8192 }
}
```
