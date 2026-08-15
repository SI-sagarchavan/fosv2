# Surface Studio

The page board. Listens on `http://localhost:3000` for sends from
**FanOS Surface Canvas**. The ZIP in the plugin is the escape hatch for when
this is down.

```bash
pnpm --filter @fanos/surface-studio dev
```

| Route | Who |
| --- | --- |
| `GET /v1/health` | plugin ping |
| `POST /v1/exports` | plugin send (IR + PNGs) |
| `GET /v1/exports` | this UI, polling |

Memory only. A restart clears the board.
