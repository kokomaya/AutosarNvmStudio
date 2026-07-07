# NVM Engine Install Server

This service hosts downloadable engine scripts for the command `NVM: Install Engine from URL...`.

## What it provides

- Engine list: `GET /v1/engines`
- Latest version metadata: `GET /v1/engines/{id}/latest`
- Version metadata: `GET /v1/engines/{id}/{version}`
- Engine script download: `GET /v1/engines/{id}/{version}/engine.js`
- Publish engine (admin): `POST /v1/admin/engines/{id}/{version}`

## Publish payload

`POST /v1/admin/engines/{id}/{version}`

Headers:

- `Content-Type: application/json`
- `x-api-token: <token>`

Body:

```json
{
  "engineScript": "module.exports.createEngine = ...",
  "displayName": "Vector FEE V3",
  "description": "Reference vector fee engine",
  "sdkVersion": 4
}
```

## Environment variables

- `NVM_ENGINE_SERVER_HOST` default: `127.0.0.1`
- `NVM_ENGINE_SERVER_PORT` default: `7788`
- `NVM_ENGINE_REGISTRY_HOME` default: `<cwd>/engine-registry-data`
- `NVM_ENGINE_SERVER_ADMIN_TOKEN` required for admin publish endpoints
- `NVM_ENGINE_SERVER_TARGET` optional pkg target, default: `node20-win-x64`
- `NVM_ENGINE_SERVER_SKIP_EXE=1` skip exe generation in build

## Build output

Running `npm run compile` or `npm run package:vsix` now also generates:

- `dist/server/nvm-engine-install-server.js`
- `dist/server/start-nvm-engine-install-server.cmd`
- `dist/server/nvm-engine-install-server.exe`

These files are excluded from VSIX by `.vscodeignore`.
