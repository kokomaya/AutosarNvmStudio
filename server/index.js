"use strict";

const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const http = require("http");
const path = require("path");

const HOST = process.env.NVM_ENGINE_SERVER_HOST || "127.0.0.1";
const PORT = Number(process.env.NVM_ENGINE_SERVER_PORT || 7788);
// Single, unified data root. Everything lives under it:
//   <root>/engines/<id>/<version>/   engine packs
//   <root>/conf/                     layout descriptors (*.nvmlayout.json)
// Root = NVM_ENGINE_REGISTRY_HOME, or the current working directory.
const DATA_ROOT = path.resolve(process.env.NVM_ENGINE_REGISTRY_HOME || process.cwd());
const ENGINE_ROOT = path.join(DATA_ROOT, "engines");
const CONF_ROOT = path.join(DATA_ROOT, "conf");
const ADMIN_TOKEN = process.env.NVM_ENGINE_SERVER_ADMIN_TOKEN || "";
const MAX_BODY_BYTES = 10 * 1024 * 1024;

function json(res, statusCode, payload) {
	const body = Buffer.from(JSON.stringify(payload, null, 2));
	res.writeHead(statusCode, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": body.length,
	});
	res.end(body);
}

function text(res, statusCode, payload, contentType = "text/plain; charset=utf-8") {
	const body = Buffer.from(payload);
	res.writeHead(statusCode, {
		"Content-Type": contentType,
		"Content-Length": body.length,
	});
	res.end(body);
}

function cleanSegment(input, fieldName) {
	if (typeof input !== "string" || !/^[a-zA-Z0-9._-]+$/.test(input)) {
		throw new Error(`${fieldName} is invalid. Use only [a-zA-Z0-9._-].`);
	}
	return input;
}

function getBaseUrl(req) {
	const host = req.headers.host || `${HOST}:${PORT}`;
	return `http://${host}`;
}

async function ensureDir(dir) {
	await fsp.mkdir(dir, { recursive: true });
}

function getEnginePaths(id, version) {
	const dir = path.join(ENGINE_ROOT, id, version);
	return {
		dir,
		engineFile: path.join(dir, "engine.js"),
		manifestFile: path.join(dir, "engine.json"),
	};
}

async function resolveEngineScriptFile(id, version) {
	const { dir, engineFile, manifestFile } = getEnginePaths(id, version);
	try {
		const manifest = await readJson(manifestFile);
		if (typeof manifest.entry === "string" && manifest.entry.trim().length > 0) {
			return path.join(dir, path.basename(manifest.entry.trim()));
		}
	} catch {
		// Fall back to the default file name below.
	}
	return engineFile;
}

async function readJson(filePath) {
	const raw = await fsp.readFile(filePath, "utf8");
	return JSON.parse(raw);
}

async function writeJson(filePath, value) {
	await fsp.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

function sha256(content) {
	return crypto.createHash("sha256").update(content).digest("hex");
}

async function readBody(req) {
	let total = 0;
	const chunks = [];
	for await (const chunk of req) {
		total += chunk.length;
		if (total > MAX_BODY_BYTES) {
			throw new Error(`Request body too large. Limit is ${MAX_BODY_BYTES} bytes.`);
		}
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}

async function listEngines() {
	await ensureDir(ENGINE_ROOT);
	const engineDirs = await fsp.readdir(ENGINE_ROOT, { withFileTypes: true });
	const out = [];
	for (const dirent of engineDirs) {
		if (!dirent.isDirectory()) {
			continue;
		}
		const id = dirent.name;
		const versionRoot = path.join(ENGINE_ROOT, id);
		const versionDirs = await fsp.readdir(versionRoot, { withFileTypes: true });
		const versions = [];
		for (const versionDir of versionDirs) {
			if (!versionDir.isDirectory()) {
				continue;
			}
			const version = versionDir.name;
			const manifestFile = path.join(versionRoot, version, "engine.json");
			try {
				const manifest = await readJson(manifestFile);
				versions.push({
					version,
					publishedAt: manifest.publishedAt,
					sha256: manifest.sha256,
					displayName: manifest.displayName || id,
					sdkVersion: manifest.sdkVersion,
				});
			} catch {
				// Skip malformed/incomplete versions.
			}
		}
		versions.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
		if (versions.length > 0) {
			out.push({ id, latest: versions[0].version, versions });
		}
	}
	out.sort((a, b) => a.id.localeCompare(b.id));
	return out;
}

async function getVersionManifest(id, version) {
	const { manifestFile } = getEnginePaths(id, version);
	return readJson(manifestFile);
}

function requireAdmin(req) {
	if (!ADMIN_TOKEN) {
		return { ok: false, reason: "Admin token is not configured on server." };
	}
	const provided = req.headers["x-api-token"];
	if (provided !== ADMIN_TOKEN) {
		return { ok: false, reason: "Invalid admin token." };
	}
	return { ok: true };
}

async function publishEngine(req, res, id, version) {
	const auth = requireAdmin(req);
	if (!auth.ok) {
		return json(res, 403, { error: auth.reason });
	}

	let payload;
	try {
		const body = await readBody(req);
		payload = JSON.parse(body);
	} catch (error) {
		return json(res, 400, { error: `Invalid JSON body. ${error.message}` });
	}

	if (!payload || typeof payload.engineScript !== "string" || payload.engineScript.trim() === "") {
		return json(res, 400, { error: "engineScript is required and must be a non-empty string." });
	}

	const script = payload.engineScript;
	const scriptSha = sha256(script);
	const now = new Date().toISOString();
	const paths = getEnginePaths(id, version);
	await ensureDir(paths.dir);
	await fsp.writeFile(paths.engineFile, script, "utf8");

	const manifest = {
		id,
		version,
		displayName: typeof payload.displayName === "string" ? payload.displayName : id,
		description: typeof payload.description === "string" ? payload.description : "",
		sdkVersion:
			typeof payload.sdkVersion === "number" && Number.isFinite(payload.sdkVersion)
				? payload.sdkVersion
				: undefined,
		entry: "engine.js",
		sha256: scriptSha,
		publishedAt: now,
		source: "registry",
	};
	await writeJson(paths.manifestFile, manifest);

	return json(res, 201, {
		ok: true,
		id,
		version,
		sha256: scriptSha,
		downloadUrl: `/v1/engines/${id}/${version}/engine.js`,
	});
}

async function listConfigs() {
	await ensureDir(CONF_ROOT);
	const entries = await fsp.readdir(CONF_ROOT, { withFileTypes: true });
	const out = [];
	for (const dirent of entries) {
		if (dirent.isFile() && dirent.name.toLowerCase().endsWith(".nvmlayout.json")) {
			out.push(dirent.name);
		}
	}
	out.sort();
	return out;
}

async function requestHandler(req, res) {
	const method = req.method || "GET";
	const url = new URL(req.url || "/", getBaseUrl(req));
	const pathname = url.pathname;

	try {
		if (method === "GET" && pathname === "/health") {
			return json(res, 200, {
				ok: true,
				name: "nvm-engine-install-server",
				port: PORT,
				dataRoot: DATA_ROOT,
				time: new Date().toISOString(),
			});
		}

		if (method === "GET" && pathname === "/v1/engines") {
			const engines = await listEngines();
			return json(res, 200, { engines });
		}

		if (method === "GET" && pathname === "/v1/configs") {
			const configs = await listConfigs();
			return json(res, 200, {
				configs: configs.map(name => ({
					name,
					downloadUrl: `${getBaseUrl(req)}/v1/configs/${encodeURIComponent(name)}`,
				})),
			});
		}

		const configFileMatch = pathname.match(/^\/v1\/configs\/([a-zA-Z0-9._-]+\.nvmlayout\.json)$/);
		if (method === "GET" && configFileMatch) {
			const name = configFileMatch[1];
			if (name.includes("..") || name.includes("/") || name.includes("\\")) {
				return json(res, 400, { error: "Invalid config name." });
			}
			const file = path.join(CONF_ROOT, name);
			try {
				const stat = await fsp.stat(file);
				res.writeHead(200, {
					"Content-Type": "application/json; charset=utf-8",
					"Content-Length": stat.size,
					"Cache-Control": "public, max-age=300",
				});
				fs.createReadStream(file).pipe(res);
				return;
			} catch {
				return json(res, 404, { error: `Config ${name} not found.` });
			}
		}

		const latestMatch = pathname.match(/^\/v1\/engines\/([a-zA-Z0-9._-]+)\/latest$/);
		if (method === "GET" && latestMatch) {
			const id = cleanSegment(latestMatch[1], "id");
			const engines = await listEngines();
			const engine = engines.find(e => e.id === id);
			if (!engine) {
				return json(res, 404, { error: `Engine ${id} not found.` });
			}
			const manifest = await getVersionManifest(id, engine.latest);
			return json(res, 200, {
				...manifest,
				downloadUrl: `${getBaseUrl(req)}/v1/engines/${id}/${engine.latest}/engine.js`,
			});
		}

		const versionMatch = pathname.match(/^\/v1\/engines\/([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)$/);
		if (method === "GET" && versionMatch) {
			const id = cleanSegment(versionMatch[1], "id");
			const version = cleanSegment(versionMatch[2], "version");
			try {
				const manifest = await getVersionManifest(id, version);
				return json(res, 200, {
					...manifest,
					downloadUrl: `${getBaseUrl(req)}/v1/engines/${id}/${version}/engine.js`,
				});
			} catch {
				return json(res, 404, { error: `Engine ${id}@${version} not found.` });
			}
		}

		const engineFileMatch = pathname.match(
			/^\/v1\/engines\/([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)\/engine\.js$/,
		);
		if (method === "GET" && engineFileMatch) {
			const id = cleanSegment(engineFileMatch[1], "id");
			const version = cleanSegment(engineFileMatch[2], "version");
			const engineFile = await resolveEngineScriptFile(id, version);
			try {
				const stat = await fsp.stat(engineFile);
				res.writeHead(200, {
					"Content-Type": "application/javascript; charset=utf-8",
					"Content-Length": stat.size,
					"Cache-Control": "public, max-age=300",
				});
				fs.createReadStream(engineFile).pipe(res);
				return;
			} catch {
				return json(res, 404, { error: `Engine script ${id}@${version} not found.` });
			}
		}

		const publishMatch = pathname.match(/^\/v1\/admin\/engines\/([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)$/);
		if (method === "POST" && publishMatch) {
			const id = cleanSegment(publishMatch[1], "id");
			const version = cleanSegment(publishMatch[2], "version");
			return publishEngine(req, res, id, version);
		}

		return json(res, 404, { error: `Route not found: ${method} ${pathname}` });
	} catch (error) {
		return json(res, 500, { error: error instanceof Error ? error.message : String(error) });
	}
}

function createServer() {
	return http.createServer(requestHandler);
}

function startServer() {
	Promise.all([ensureDir(ENGINE_ROOT), ensureDir(CONF_ROOT)])
		.then(() => {
			const server = createServer();
			server.listen(PORT, HOST, () => {
				// eslint-disable-next-line no-console
				console.log(`NVM engine install server listening on http://${HOST}:${PORT}`);
				// eslint-disable-next-line no-console
				console.log(`Data root: ${DATA_ROOT}`);
			});
		})
		.catch(error => {
			// eslint-disable-next-line no-console
			console.error("Failed to start NVM engine install server:", error);
			process.exitCode = 1;
		});
}

if (require.main === module) {
	startServer();
}

module.exports = {
	createServer,
	startServer,
};
