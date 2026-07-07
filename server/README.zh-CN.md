# 生产环境：从 0 到解析 block

本手册覆盖生产环境完整流程：部署引擎服务 → 安装引擎 → 放置配置 → 打开 dump 解析出 block。

解析 block 需要三样东西同时到位：

1. 引擎(engine)：已安装,且 id 与描述文件里的 `engine` 一致。
2. 描述文件(`*.nvmlayout.json`)：能被发现。
3. 描述文件声明的源文件(如 `Fee_Lcfg.c`、`*.h`、`*.arxml`)：能被发现。

缺任意一样都解析不出 block。

---

## 第 0 步：前置条件

1. 桌面版 VS Code(非 web),工作区受信任(Workspace Trust)。
2. 设置 `nvmstudio.nvm.allowExternalEngines = true`。

---

## 第 1 步：部署引擎服务(server)

引擎服务用于分发引擎脚本,供 VS Code 从 URL 安装。

引擎在服务端的目录结构：

```
<数据根>/engines/<engineId>/<version>/
    engine.json      # 清单，entry 指向脚本文件名
    <脚本文件>.js     # 引擎脚本（文件名由 engine.json 的 entry 决定）
<数据根>/conf/           # 布局描述文件(*.nvmlayout.json)
```

数据根统一确定(去掉了 engine-registry-data 的特殊处理)：

- 环境变量 `NVM_ENGINE_REGISTRY_HOME`,未设置时用启动目录。
- 引擎固定在 `<数据根>/engines`,配置固定在 `<数据根>/conf`。

启动服务(推荐显式指定数据根)：

```powershell
$env:NVM_ENGINE_REGISTRY_HOME = "D:\path\to\registry"
node dist/server/nvm-engine-install-server.js
```

或用 exe：

```powershell
$env:NVM_ENGINE_REGISTRY_HOME = "D:\path\to\registry"
.\dist\server\nvm-engine-install-server.exe
```

启动日志的 `Data root:` 必须指向包含 `engines/` 的目录。

环境变量：

- `NVM_ENGINE_SERVER_HOST` 默认 `127.0.0.1`
- `NVM_ENGINE_SERVER_PORT` 默认 `7788`
- `NVM_ENGINE_REGISTRY_HOME` 数据根
- `NVM_ENGINE_SERVER_ADMIN_TOKEN` 发布接口所需

接口：

- `GET /health`
- `GET /v1/engines`
- `GET /v1/engines/{id}/{version}`
- `GET /v1/engines/{id}/{version}/engine.js`
- `POST /v1/admin/engines/{id}/{version}`（需头 `x-api-token`）
- `GET /v1/configs`（列出 `<数据根>/conf` 下的 `*.nvmlayout.json`）
- `GET /v1/configs/{name}`（下载单个描述文件）

---

## 第 2 步：把引擎放到服务端

### 方式 A：手工落盘

按目录结构放置文件,`engine.json` 示例：

```json
{
  "id": "vector-fee-v3",
  "version": "1.0.0",
  "displayName": "Vector FEE V3",
  "entry": "vectorFeeV3.engine.js",
  "sdkVersion": 3
}
```

`entry` 可为任意脚本文件名,下载接口按它返回真实文件。

### 方式 B：发布接口

```powershell
$headers = @{ "x-api-token" = "your-token" }
$body = @{
  engineScript = (Get-Content -Raw .\vectorFeeV3.engine.js)
  displayName  = "Vector FEE V3"
  sdkVersion   = 3
} | ConvertTo-Json

Invoke-RestMethod -Method Post `
  -Uri "http://127.0.0.1:7788/v1/admin/engines/vector-fee-v3/1.0.0" `
  -Headers $headers -ContentType "application/json" -Body $body
```

---

## 第 3 步：VS Code 安装引擎

### 从 URL 安装

1. 命令面板执行 `NVM: Install Engine from URL...`
2. 输入：

```
http://127.0.0.1:7788/v1/engines/vector-fee-v3/1.0.0/engine.js
```

3. 确认 Download & install。

引擎安装到统一的用户目录：`%USERPROFILE%\nvmstudio\engines\<id>\`(可用环境变量 `NVMSTUDIO_HOME` 覆盖)。按 id 自动解析,nvmlayout 里写 `engine: vector-fee-v3` 即可,无需额外设置。

要点：

- id 从 URL 中 `engines/<id>` 段自动识别(得到 `vector-fee-v3`)。
- 成功提示会显示安装目录(扩展全局存储下的 `engines/<id>/`)。
- 安装后的 id **必须**等于描述文件里的 `engine` 值,否则生产环境解析不出 block。

### 或本地安装

1. 命令面板执行 `NVM: Install Engine...`
2. 选择含 `engine.json` 的引擎目录,或单个 `.engine.js` 文件。

### 核对

命令面板执行 `NVM: Manage Engines`,确认列表里是 `vector-fee-v3`,不是 `engine`。

---

## 第 4 步：放置描述文件与源文件

这两类是**项目/平台配置**,不随引擎服务安装,需各自就位。

### 描述文件 `*.nvmlayout.json`

发现路径(命中其一即可)：

1. dump 所在目录
2. dump 目录下 `./conf`
3. dump 上级目录下 `../conf`
4. 设置 `nvmstudio.nvm.layoutRoots` 里配置的全局目录(及其 `conf/` 子目录)

推荐从服务器一键安装(自动写设置)：

1. 先把描述文件放到服务端 `<数据根>/conf/`。
2. 命令面板执行 `NVM: Install Layout Configs from URL...`
3. 输入服务器基址 `http://127.0.0.1:7788`
4. 扩展会把描述文件下载到统一用户目录 `%USERPROFILE%\nvmstudio\conf`,并**自动**把该目录写入 `nvmstudio.nvm.layoutRoots`。

也可手动配置(全局共享目录)：

```jsonc
"nvmstudio.nvm.layoutRoots": [
  "C:\\Users\\<you>\\nvmstudio\\conf"
]
```

`layoutRoots` 支持工作区外的绝对路径,直接扫描目录本身和它的 `conf/`。

### 源文件(描述文件 `sources` 声明的文件)

发现路径：

1. dump 目录 / `./conf` / `../conf`
2. 设置 `nvmstudio.nvm.workspaceRoots` 里配置的目录(递归查找)

把源文件所在的项目目录配进去：

```jsonc
"nvmstudio.nvm.workspaceRoots": [
  "${workspaceFolder}/src/DaVinci/ARS620_S2A2_EM_B2_2CAN"
]
```

`workspaceRoots` 用递归索引,面向工作区内的项目目录。

### 三类目录职责区分(不重复)

- `layoutRoots`：放描述文件(全局目录,可在工作区外)
- `workspaceRoots`：找源文件(项目目录,工作区内)
- dump 目录 / `./conf` / `../conf`：永远自动扫描,不用配

---

## 第 5 步：打开 dump 并验证

1. 打开 dump 文件(hex 编辑器)。
2. 首次运行引擎会弹安全确认,选择 Run once 或 Always run this file。
3. 若配置正确,block 会被解析并着色,NVM Studio 视图里显示 block 列表。

---

## 常见问题

- 装了引擎仍解析不出 block(调试可用、生产不可用)：安装的 id 不等于描述文件的 `engine`。用 `NVM: Manage Engines` 删掉错误的 `engine`,重新用标准 URL 安装,使 id = `vector-fee-v3`。
- 配置“没被识别”：多数是引擎没解析出来的表象。先确认引擎 id 正确、描述文件与源文件都能被发现。
- 安装 404：服务数据根没指向包含 `engines/`(或 `conf/`)的目录,用 `NVM_ENGINE_REGISTRY_HOME` 显式指定后重启服务。数据根统一为 `<root>/engines` 与 `<root>/conf`。
- 统一用户目录：引擎与 conf 都装在 `%USERPROFILE%\nvmstudio`(可用 `NVMSTUDIO_HOME` 覆盖),分别在 `engines/` 和 `conf/`。
- 描述文件在工作区外没被发现：描述文件的工作区外发现只走 `nvmstudio.nvm.layoutRoots`,确认已配置。
- 改了服务代码不生效：重启服务进程；改了扩展代码：Developer: Reload Window(或重装 VSIX)。
