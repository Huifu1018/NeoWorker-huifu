# Windows search and fetch proxy recovery

Reported symptom: both built-in search and web_fetch fail with
`net::ERR_PROXY_CONNECTION_FAILED`. The Windows machine's proxy address was
not available for inspection; the screenshot alone does not identify which
proxy software or system setting caused it.

The code used Chromium's system-proxy transport for Bing and web_fetch without
an alternate route. DuckDuckGo had a separate Node fallback, which could time
out before returning to the same broken Bing proxy path.

Changes:

- Shared system-proxy-first transport for DDG, Bing and web_fetch/http_request.
- One isolated, non-persistent direct-session attempt on exactly
  ERR_PROXY_CONNECTION_FAILED for GET/HEAD and explicitly replay-safe search POST.
- No changes to default session/OS proxy configuration. No proxy-auth headers
  or browser cookies forwarded to the direct session.
- HTTP authentication/access denials, certificate failures, mandatory proxy/PAC
  failures and ordinary timeouts do not trigger direct-session recovery.
- Writes are not replayed. Existing abort signals, redirect policy and domain
  checks remain in effect. A dual failure names both routes in the error.
- Windows installer workflow now runs the regression suite and actual Electron
  transport test before publishing the artifact.

Validation:

- Electron TypeScript build passed on macOS.
- 99 focused tests passed (20 transport, 3 search, 76 web fetch).
- Real Electron test: closed local proxy reproduces Chromium error; read and
  search requests recover, default proxy stays unchanged, ordinary POST is not
  replayed. All network endpoints are local test fixtures.
- Changed transport/test files passed oxlint; diff whitespace check passed.

Limit: automatic direct recovery cannot make a destination reachable on a
network that requires a working proxy. The user's Windows network still needs
testing with the updated installer.
