# Pi SRE

Pi SRE is a read-only Kubernetes incident diagnosis application built on the Pi agent runtime and Kubernetes MCP Server. It is intentionally an independent TypeScript application, not a Pi package.

The implementation follows the architecture in [docs/DESIGN.md](docs/DESIGN.md). The current repository state is a Phase 1 project scaffold; source modules are deliberately not implemented yet.

## Prerequisites

- Node.js 22 or later
- A Kubernetes MCP Server executable available as `kubernetes-mcp-server`
- Kubernetes credentials with read-only RBAC

## Setup

```bash
npm install
cp config/pi-sre.example.yaml ~/.pi-sre/config.yaml
cp config/kubernetes-mcp.example.toml ~/.pi-sre/kubernetes-mcp.toml
```

Review the copied configuration before use. The MCP server configuration and Kubernetes RBAC must both remain read-only.

## Commands

```bash
npm run check
npm run lint
npm test
npm run build
```

Planned application usage is `pi-sre --cluster <context>`. The CLI and runtime are not implemented in this scaffold.

## Layout

- `src/` — application, runtime, MCP bridge, cluster state, domain, configuration, and TUI modules
- `skills/` — reusable Kubernetes diagnostic skills
- `tests/` — unit, integration, and end-to-end test suites
- `evals/` — kind-based diagnosis evaluation framework and cases
- `config/` — safe, versioned configuration templates
