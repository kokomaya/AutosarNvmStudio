import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceFile = join(repoRoot, "server", "index.js");
const distDir = join(repoRoot, "dist", "server");
const distEntry = join(distDir, "nvm-engine-install-server.js");
const distCmd = join(distDir, "start-nvm-engine-install-server.cmd");
const distExe = join(distDir, "nvm-engine-install-server.exe");

mkdirSync(distDir, { recursive: true });
copyFileSync(sourceFile, distEntry);

const cmdContent = [
	"@echo off",
	"setlocal",
	"if not defined NVM_ENGINE_SERVER_PORT set NVM_ENGINE_SERVER_PORT=7788",
	"if not defined NVM_ENGINE_SERVER_HOST set NVM_ENGINE_SERVER_HOST=127.0.0.1",
	"if not defined NVM_ENGINE_REGISTRY_HOME set NVM_ENGINE_REGISTRY_HOME=%cd%\\engine-registry-data",
	"node nvm-engine-install-server.js",
	"endlocal",
	"",
].join("\r\n");
writeFileSync(distCmd, cmdContent, "utf8");

if (process.env.NVM_ENGINE_SERVER_SKIP_EXE === "1") {
	console.log("Skipped exe generation because NVM_ENGINE_SERVER_SKIP_EXE=1");
	process.exit(0);
}

const pkgBin = process.platform === "win32" ? "pkg.cmd" : "pkg";
const localPkg = join(repoRoot, "node_modules", ".bin", pkgBin);
const pkgCmd = existsSync(localPkg) ? localPkg : "npx";
const pkgArgs = existsSync(localPkg)
	? [distEntry, "--target", process.env.NVM_ENGINE_SERVER_TARGET || "node20-win-x64", "--output", distExe]
	: ["pkg", distEntry, "--target", process.env.NVM_ENGINE_SERVER_TARGET || "node20-win-x64", "--output", distExe];

const result = spawnSync(pkgCmd, pkgArgs, {
	cwd: repoRoot,
	stdio: "inherit",
	shell: process.platform === "win32",
});

if (result.status !== 0) {
	throw new Error("Failed to generate nvm-engine-install-server executable.");
}

if (process.platform !== "win32") {
	chmodSync(distExe, 0o755);
}

console.log(`Built ${distExe}`);
