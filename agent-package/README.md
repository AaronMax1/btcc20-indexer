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

Default BTCC-20 parameter files are included:

- `deploy.txt`
- `mint.txt`
- `transfer.txt`

They default to `cord`. Edit the txt files if you want to use another ticker,
amount, count, or destination.

Live execution is enabled by default. To test without broadcasting, set:

```sh
BTCC20_AGENT_DRY_RUN=1
```

The agent refuses live execution when the local BTCC Core node is not fully synced.
