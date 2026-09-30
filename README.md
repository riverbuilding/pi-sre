# Pi SRE

Pi SRE is a read-only Kubernetes incident diagnosis application built on the Pi agent runtime and Kubernetes MCP Server. It is intentionally an independent TypeScript application, not a Pi package.

The implementation follows the architecture in [docs/DESIGN.md](docs/DESIGN.md). Phase 1 Slices 0–3 provide configuration validation, a Pi TUI, an isolated SRE resource boundary, and a managed Kubernetes MCP connection. MCP tool discovery and model-facing diagnostic tools are planned for later slices.

## Prerequisites

- Node.js 22 or later
- A Kubernetes MCP Server executable available as `kubernetes-mcp-server`
- Kubernetes credentials with read-only RBAC

## Setup

```bash
npm install
mkdir -p ~/.pi-sre
cp config/pi-sre.example.yaml ~/.pi-sre/config.yaml
cp config/kubernetes-mcp.example.toml ~/.pi-sre/kubernetes-mcp.toml
```

Review the copied configuration before use. The MCP server configuration and Kubernetes RBAC must both remain read-only.
Pi SRE requires `read_only = true` in the MCP TOML and launches the server with `--config ~/.pi-sre/kubernetes-mcp.toml`.

## Application Home

Pi SRE stores its configuration and persisted runtime state in one application-owned directory:

```text
~/.pi-sre/
├── config.yaml
├── kubernetes-mcp.toml
├── auth.json
├── models.json
├── settings.json
├── sessions/
└── logs/
```

The runtime uses this directory for model credentials, model metadata, settings, and sessions. Pi may create additional runtime files there. It reuses Pi's runtime and provider integration without reading from or writing to Pi Coding Agent's default storage.

The configuration loader uses `~/.pi-sre/config.yaml` by default. `PI_SRE_HOME` changes the application root; `PI_SRE_CONFIG` selects another YAML file; and `PI_SRE_MCP_COMMAND` overrides the MCP executable. Relative paths in YAML resolve from that YAML file's directory. The loader requires a readable MCP TOML file with `read_only = true` and stdio transport, then appends `--config <absolute path>` to the server command.

## Commands

```bash
npm run check
npm run lint
npm test
npm run build
npm run dev -- --help
npm run dev
```

The built executable is `dist/main.js`; `npm link` also makes `pi-sre` available on your PATH. The current runtime opens Pi's TUI with no coding-agent tools or shell execution. It uses a Pi SRE system prompt and does not load project instructions, extensions, skills, or prompt templates. It starts and health-checks the configured Kubernetes MCP process, then closes it when the TUI exits. If MCP startup fails, the TUI opens with a warning but cannot inspect Kubernetes. Check the MCP configuration and restart `pi-sre`; in-session reconnection is not implemented. Kubernetes tools are not yet exposed to the model; tool discovery and exposure arrive in later Phase 1 slices. Cluster selection with `--cluster` is planned for Phase 2.

## Layout

- `src/` — application, runtime, MCP bridge, cluster state, domain, configuration, and TUI modules
- `skills/` — reusable Kubernetes diagnostic skills
- `tests/` — unit, integration, and end-to-end test suites
- `evals/` — kind-based diagnosis evaluation framework and cases
- `config/` — safe, versioned configuration templates
