#!/usr/bin/env node
// Packs the fork's extension and proves the tarball is actually loadable.
//
// The package ships TypeScript source and lists every shipped module by hand in
// `files`, so a new module is only one forgotten line away from being absent from
// the published artifact. That failure is invisible locally, because the monorepo
// working tree always has the file, and it is unfixable after publish except by
// burning a version number.
//
// So: pack, extract, then walk the real import graph from the entry points and
// require every hop to exist inside the tarball. Bare specifiers are checked
// against the manifest's own dependency lists, which catches a production module
// importing a workspace-only package such as rpiv-test-utils.
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_DIR = join(ROOT, "packages", "rpiv-ask-user-question");
const manifest = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8"));

const allowedBare = new Set([
	...Object.keys(manifest.dependencies ?? {}),
	...Object.keys(manifest.peerDependencies ?? {}),
]);

const work = mkdtempSync(join(tmpdir(), "rpiv-pack-"));
const failures = [];
try {
	// Shelling out through execSync rather than execFileSync: on Windows npm is a
	// .cmd shim, which recent Node refuses to spawn without a shell after the batch
	// argument-injection fix. Every argument here is a literal except the temp path,
	// which is quoted, so shell interpretation has nothing to latch onto.
	// --silent keeps npm's own chatter out of the captured filename.
	const tarball = execSync(`npm pack -w ${manifest.name} --pack-destination "${work}" --silent`, {
		cwd: ROOT,
		encoding: "utf8",
	})
		.trim()
		.split("\n")
		.pop()
		.trim();

	execFileSync("tar", ["-xzf", join(work, tarball), "-C", work], { stdio: "inherit" });
	const shipped = join(work, "package");

	const entries = new Set();
	for (const e of manifest.pi?.extensions ?? []) entries.add(e);
	for (const target of Object.values(manifest.exports ?? {})) {
		if (typeof target === "string") entries.add(target);
	}

	// Two resolution quirks, both load-bearing. TypeScript under Node16 resolution
	// wants runtime-correct specifiers, so source files import "./foo.js" while the
	// shipped module is foo.ts; that rewrite is tried first. And a bare "./state"
	// that names a directory must fall through to ./state.ts then ./state/index.ts,
	// so every candidate is required to be a file rather than merely to exist.
	const resolveSpec = (fromFile, spec) => {
		const base = resolve(dirname(fromFile), spec);
		const candidates = [];
		if (/\.(js|mjs|cjs)$/.test(base)) {
			candidates.push(
				base
					.replace(/\.js$/, ".ts")
					.replace(/\.mjs$/, ".mts")
					.replace(/\.cjs$/, ".cts"),
			);
		}
		candidates.push(base, `${base}.ts`, join(base, "index.ts"));
		for (const cand of candidates) {
			if (existsSync(cand) && statSync(cand).isFile()) return cand;
		}
		return null;
	};

	const seen = new Set();
	const queue = [];
	for (const e of entries) {
		const f = resolve(shipped, e);
		if (!existsSync(f)) {
			failures.push(`entry point missing from tarball: ${e}`);
			continue;
		}
		queue.push(f);
	}

	while (queue.length > 0) {
		const file = queue.pop();
		if (seen.has(file)) continue;
		seen.add(file);
		const src = readFileSync(file, "utf8");
		const specs = [
			...src.matchAll(/(?:^|[\s;}])(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g),
			...src.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
			...src.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g),
		].map((m) => m[1]);

		for (const spec of specs) {
			if (spec.startsWith("node:")) continue;
			if (spec.startsWith(".")) {
				const target = resolveSpec(file, spec);
				if (!target) {
					failures.push(`${relative(shipped, file)} imports "${spec}", which is NOT in the tarball`);
					continue;
				}
				queue.push(target);
				continue;
			}
			const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
			if (!allowedBare.has(name)) {
				failures.push(
					`${relative(shipped, file)} imports "${spec}", but ${name} is in neither dependencies nor peerDependencies`,
				);
			}
		}
	}

	console.log(`packed ${tarball}`);
	console.log(`reachable modules verified: ${seen.size}`);
} finally {
	rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(`\n${failures.length} problem(s) would ship in this tarball:`);
	for (const f of [...new Set(failures)]) console.error(`  - ${f}`);
	process.exit(1);
}
console.log("tarball is self-contained");
