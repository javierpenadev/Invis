# Third-party components and licenses

Invis is licensed under **GPL-3.0** (inherited from InviZible Pro, whose functionality it re-implements).
It bundles official builds of the following third-party daemons. Source code and full license
texts are available from the official sources listed below.

| Component | Version | License | Source |
|---|---|---|---|
| Tor (Windows Expert Bundle) | 0.4.9.12 (bundle 15.0.22) | BSD-3-clause (see also bundle LICENSE) | https://dist.torproject.org/torbrowser/ , https://gitlab.torproject.org/tpo/core/tor |
| obfs4proxy (lyrebird) | bundled with Tor | BSD-2/3 + GPLv3 parts | https://gitlab.torproject.org/tpo/anti-censorship/pluggable-transports/lyrebird |
| conjure | bundled with Tor | GPLv3 (refraction networking) | https://github.com/refraction-networking/conjure |
| dnscrypt-proxy | 2.1.18 | ISC | https://github.com/DNSCrypt/dnscrypt-proxy |
| i2pd (Purple I2P) | 2.61.0 | BSD-3-clause | https://github.com/PurpleI2P/i2pd |

Runtime infrastructure:

| Component | License | Source |
|---|---|---|
| Electron | MIT | https://www.electronjs.org |
| Chromium, Node.js (inside Electron) | BSD-style, MIT etc. | see Electron |
| WinTun/FSO/PowerShell usage | system components | — |

This application also draws functional inspiration from
[InviZible Pro for Android](https://github.com/Gedsh/InviZible) (GPL-3.0) — no source code was copied.

Tor flags used at runtime: ClientOnly, NoExec, CookieAuthentication — the bundled tor.exe is used unmodified.
dnscrypt-proxy uses the public resolvers list (https://github.com/DNSCrypt/dnscrypt-resolvers, CC0).
