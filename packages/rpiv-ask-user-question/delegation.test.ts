import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	agentDirFrom,
	MIRROR_HOST_MARKER,
	shouldDeferToMirror,
	userInstalledMirror,
} from "./delegation.js";

const MIRROR_NPM = "npm:@jetserge/pi-telegram-ask-mirror";
const MIRROR_DEV_PATH = "/home/dev/checkouts/pi-telegram-ask-mirror";

const created: string[] = [];
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;

/** Point PI_CODING_AGENT_DIR at a throwaway agent dir holding these settings. */
function withSettings(contents: string | undefined): void {
	const dir = mkdtempSync(join(tmpdir(), "rpiv-delegation-"));
	created.push(dir);
	if (contents !== undefined) writeFileSync(join(dir, "settings.json"), contents, "utf8");
	process.env.PI_CODING_AGENT_DIR = dir;
}

function settingsWith(packages: unknown): string {
	return JSON.stringify({ theme: "dark", packages });
}

afterEach(() => {
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Pure, so both branches Pi resolves for us are covered without touching a
// real home directory or depending on this machine's own agent dir.
describe("agentDirFrom", () => {
	const HOME = join("/", "home", "someone");

	it("falls back to the default agent dir when unset or empty", () => {
		expect(agentDirFrom(undefined, HOME)).toBe(join(HOME, ".pi", "agent"));
		expect(agentDirFrom("", HOME)).toBe(join(HOME, ".pi", "agent"));
	});

	it("expands a bare tilde to the home directory", () => {
		expect(agentDirFrom("~", HOME)).toBe(HOME);
	});

	it("expands a leading tilde with either separator", () => {
		expect(agentDirFrom("~/custom/agent", HOME)).toBe(join(HOME, "custom", "agent"));
		expect(agentDirFrom("~\\custom\\agent", HOME)).toBe(join(HOME, "custom\\agent"));
	});

	it("passes an ordinary path through untouched", () => {
		expect(agentDirFrom("/etc/pi/agent", HOME)).toBe("/etc/pi/agent");
	});

	it("does not expand a tilde that is not leading", () => {
		expect(agentDirFrom("/opt/~/agent", HOME)).toBe("/opt/~/agent");
	});
});

describe("userInstalledMirror", () => {
	it("finds a mirror declared as a bare npm specifier", () => {
		withSettings(settingsWith(["npm:pi-web-access", MIRROR_NPM]));
		expect(userInstalledMirror()).toBe(true);
	});

	it("finds a mirror declared as an absolute development path", () => {
		withSettings(settingsWith([MIRROR_DEV_PATH]));
		expect(userInstalledMirror()).toBe(true);
	});

	it("finds a mirror declared as an object entry", () => {
		withSettings(settingsWith([{ source: MIRROR_NPM, skills: [] }]));
		expect(userInstalledMirror()).toBe(true);
	});

	it("ignores a mirror whose extensions are filtered off", () => {
		// Present but switched off. Deferring would leave nobody registering.
		withSettings(settingsWith([{ source: MIRROR_NPM, extensions: [] }]));
		expect(userInstalledMirror()).toBe(false);
	});

	it("reports no mirror for unrelated packages", () => {
		withSettings(settingsWith(["npm:pi-web-access", { source: "npm:pi-memory" }]));
		expect(userInstalledMirror()).toBe(false);
	});

	// Every malformed input has to answer "no mirror", because that is the
	// behaviour of every release before the guard existed.
	it("reports no mirror when the settings file is absent", () => {
		withSettings(undefined);
		expect(userInstalledMirror()).toBe(false);
	});

	it("reports no mirror when the settings file is not JSON", () => {
		withSettings("{ this is not json");
		expect(userInstalledMirror()).toBe(false);
	});

	it("reports no mirror when packages is not an array", () => {
		withSettings(settingsWith({ source: MIRROR_NPM }));
		expect(userInstalledMirror()).toBe(false);
	});

	it("reports no mirror when packages is missing entirely", () => {
		withSettings(JSON.stringify({ theme: "dark" }));
		expect(userInstalledMirror()).toBe(false);
	});
});

describe("shouldDeferToMirror", () => {
	it("defers when the user installed a mirror", () => {
		withSettings(settingsWith([MIRROR_NPM]));
		expect(shouldDeferToMirror({})).toBe(true);
	});

	it("registers normally when no mirror is installed", () => {
		withSettings(settingsWith(["npm:pi-memory"]));
		expect(shouldDeferToMirror({})).toBe(false);
	});

	// The mirror borrows this questionnaire by calling the default export
	// itself. That call must get the real registration even though a mirror is
	// installed, or the mirror would have nothing to wrap.
	it("never defers to a caller that identifies itself as the mirror", () => {
		withSettings(settingsWith([MIRROR_NPM]));
		expect(shouldDeferToMirror({ [MIRROR_HOST_MARKER]: true })).toBe(false);
	});

	it("ignores a marker that is present but not true", () => {
		withSettings(settingsWith([MIRROR_NPM]));
		expect(shouldDeferToMirror({ [MIRROR_HOST_MARKER]: "yes" })).toBe(true);
	});

	it("survives a caller whose marker property throws", () => {
		withSettings(settingsWith(["npm:pi-memory"]));
		const hostile = new Proxy(
			{},
			{
				get() {
					throw new Error("no");
				},
			},
		);
		expect(() => shouldDeferToMirror(hostile)).not.toThrow();
		expect(shouldDeferToMirror(hostile)).toBe(false);
	});

	it("tolerates a non-object caller", () => {
		withSettings(settingsWith(["npm:pi-memory"]));
		expect(shouldDeferToMirror(undefined)).toBe(false);
		expect(shouldDeferToMirror(null)).toBe(false);
	});
});
