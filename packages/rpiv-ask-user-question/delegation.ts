/**
 * Yielding the `ask_user_question` tool name to a mirror package.
 *
 * Pi treats two extensions registering the same tool name as a fatal load
 * error, and it resolves settings with project scope winning over user scope
 * (`package-manager.ts`, `dedupePackages`). A user who installs a wrapper such
 * as `@jetserge/pi-telegram-ask-mirror` therefore cannot stop a project's
 * `.pi/settings.json` from also loading this package. Pi starts, finds both
 * registrations, and refuses to run.
 *
 * Only this package can break that tie, because only this package can decline
 * the name. So it checks whether the user installed a mirror, and if so
 * registers nothing and lets the mirror own the tool.
 *
 * Two properties matter more than the mechanism:
 *
 * 1. It fails closed. Every unreadable, missing or unrecognised settings file
 *    answers "no mirror", which is the behaviour of every release before this
 *    one. A user without a mirror cannot be affected by any of this.
 * 2. The mirror itself is exempt. A mirror borrows this package's
 *    questionnaire by importing the module and calling the default export
 *    against a Proxy. That call must always get the real registration, or the
 *    mirror would have nothing to wrap. The mirror identifies itself by
 *    answering `true` for MIRROR_HOST_MARKER, which is the contract between
 *    the two packages.
 *
 * Only user-scope settings are consulted. A mirror is a personal choice about
 * how questions reach one operator, so a project that declared one would be
 * imposing it on everybody who opens the repository.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Property a mirror sets to `true` on the ExtensionAPI it passes to this
 * package's default export, to declare that it is the caller.
 *
 * Renaming this breaks every mirror that relies on it, so treat it as public
 * API rather than an internal detail.
 */
export const MIRROR_HOST_MARKER = "__askUserQuestionMirrorHost__";

/**
 * Substring identifying a mirror package in a settings entry.
 *
 * Matching on a substring rather than an exact specifier is deliberate: the
 * same package appears as `npm:@jetserge/pi-telegram-ask-mirror` once
 * published and as an absolute path while it is developed, and both mean the
 * mirror is present.
 */
const MIRROR_SOURCE_TOKEN = "pi-telegram-ask-mirror";

/** Mirrors Pi's own `getAgentDir()`, which this package cannot import. */
function userSettingsPath(): string {
	const configured = process.env.PI_CODING_AGENT_DIR;
	if (configured !== undefined && configured.length > 0) {
		const expanded =
			configured === "~" || configured.startsWith("~/") || configured.startsWith("~\\")
				? join(homedir(), configured.slice(1))
				: configured;
		return join(expanded, "settings.json");
	}
	return join(homedir(), ".pi", "agent", "settings.json");
}

/**
 * Whether one `packages` entry names a mirror that will actually load.
 *
 * An entry carrying an empty `extensions` array is how Pi is told to load no
 * extension from that package, so such an entry names a mirror that is present
 * but switched off. Deferring to it would leave nobody registering the tool.
 */
function isActiveMirrorEntry(entry: unknown): boolean {
	if (typeof entry === "string") return entry.includes(MIRROR_SOURCE_TOKEN);
	if (typeof entry !== "object" || entry === null) return false;
	const record = entry as { source?: unknown; extensions?: unknown };
	if (typeof record.source !== "string") return false;
	if (!record.source.includes(MIRROR_SOURCE_TOKEN)) return false;
	if (Array.isArray(record.extensions) && record.extensions.length === 0) return false;
	return true;
}

/** Whether the user's own settings install a mirror. */
export function userInstalledMirror(): boolean {
	try {
		const path = userSettingsPath();
		if (!existsSync(path)) return false;
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return false;
		const packages = (parsed as { packages?: unknown }).packages;
		if (!Array.isArray(packages)) return false;
		return packages.some(isActiveMirrorEntry);
	} catch {
		// Unreadable or malformed settings are not evidence of a mirror.
		return false;
	}
}

/** Whether this caller is a mirror borrowing the questionnaire. */
function isMirrorHost(pi: unknown): boolean {
	if (typeof pi !== "object" || pi === null) return false;
	try {
		return (pi as Record<string, unknown>)[MIRROR_HOST_MARKER] === true;
	} catch {
		// A hostile or exotic proxy must not take the tool offline.
		return false;
	}
}

/**
 * Whether to register nothing and let a mirror own `ask_user_question`.
 *
 * Answering `true` when no mirror follows would leave the model with no
 * questionnaire at all, so both checks are written to err towards registering.
 */
export function shouldDeferToMirror(pi: unknown): boolean {
	if (isMirrorHost(pi)) return false;
	return userInstalledMirror();
}
