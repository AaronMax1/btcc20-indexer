# BTCC-20 Local Agent

Local helper for BTCC-20 inscription from the explorer page.

## Start

macOS / Linux:

```sh
sh start-agent.sh
```

Windows:

```bat
start-agent.bat
```

Default ports:

- Agent: `http://127.0.0.1:28798`
- BTCC Core RPC: `http://127.0.0.1:28476`

Dry-run is enabled by default. To execute real inscription commands, set:

```sh
BTCC20_AGENT_DRY_RUN=0
```

The agent refuses live execution when the local BTCC Core node is not fully synced.
