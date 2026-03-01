# cf-tunnel

Create a tunnel to expose a local port to the internet, with multiple provider fallback support.

## Provider Support

| Provider | HTTP | TCP | Linux | macOS | Windows | Notes |
|---|---|---|---|---|---|---|
| `cf` (Cloudflare) | ✅ | ✅ | ✅ | ✅ | ✅ | Default first choice. TCP output is a hostname (requires `cloudflared` client to connect). |
| `localhost.run` | ✅ | ❌ | ✅ | ✅ | ✅ | SSH-based. Auto-generates SSH key if needed. |
| `pinggy` | ✅ | ✅ | ✅ | ✅ | ✅ | SSH-based (port 443). TCP output is `host:port`. |
| `serveo` | ✅ | ❌ | ✅ | ✅ | ✅ | SSH-based. |
| `localtunnel` | ✅ | ❌ | ✅ | ✅ | ✅ | Uses `npx localtunnel`. Requires `Bypass-Tunnel-Reminder` header. |

When `provider` is not specified, all providers are tried in order until one succeeds.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `protocol` | No | `tcp` | `tcp` or `http` |
| `port` | **Yes** | | Port to forward |
| `provider` | No | *(empty)* | Provider name: `cf`, `localhost.run`, `pinggy`, `serveo`, `localtunnel`. Empty = try all in order. |

## Outputs

| Output | Description |
|---|---|
| `server` | The tunnel server address (hostname or `host:port`) |

## Usage

```yml
name: Test

on: [push]

jobs:
  tunnel:
    runs-on: ubuntu-latest
    name: Create tunnel
    steps:
    - uses: actions/checkout@v4
    - name: Establish tunnel
      id: tunnel
      uses: vmactions/cf-tunnel@v0
      with:
        protocol: http
        port: 8080
    - name: Use tunnel
      run: echo "Tunnel URL: https://${{ steps.tunnel.outputs.server }}"
```

### Specify a provider

```yml
    - uses: vmactions/cf-tunnel@v0
      with:
        protocol: http
        port: 8080
        provider: pinggy
```

### TCP tunnel

```yml
    - uses: vmactions/cf-tunnel@v0
      with:
        protocol: tcp
        port: 22
```









