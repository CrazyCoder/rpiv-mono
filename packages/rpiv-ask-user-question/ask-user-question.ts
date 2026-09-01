import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";
import {
	COLLAPSE_KEY_OFF,
	formatKeySpecForDisplay,
	loadConfig,
	resolveCollapseKey,
	validateGuidanceFields,
} from "./config.js";
import {
	ASK_USER_BLOCKED_EVENT,
	ASK_USER_PROMPT_EVENT,
	type AskUserBlockedEventPayload,
	type AskUserPromptEventPayload,
} from "./events.js";
// Static import is fine — rpc-fallback pulls only types + the i18n bridge,
// none of the ~560ms TUI render graph that QuestionnaireSession lazy-loads.
import { type DialogUI, hasDialogUI, runRpcQuestionnaire } from "./rpc-fallback.js";
import { displayLabel, t } from "./state/i18n-bridge.js";
import { sentinelsToAppend } from "./state/row-intent.js";
import { normalizeQuestionnaire } from "./tool/normalize-questionnaire.js";
import { buildQuestionnaireResponse, buildToolResult } from "./tool/response-envelope.js";
import {
	MAX_OPTIONS,
	MAX_QUESTIONS,
	MIN_OPTIONS,
	type QuestionData,
	type QuestionnaireError,
	type QuestionnaireResult,
	type QuestionParams,
	QuestionParamsSchema,
} from "./tool/types.js";
import { validateQuestionnaire } from "./tool/validate-questionnaire.js";
import type { WrappingSelectItem } from "./view/components/wrapping-select.js";

function emitAskUserPromptEvent(pi: ExtensionAPI, params: QuestionParams): void {
	const payload: AskUserPromptEventPayload = {
		questions: params.questions.map((q) => ({
			question: q.question,
			header: q.header,
			multiSelect: q.multiSelect ?? false,
			options: q.options.map((o) => ({
				label: o.label,
				description: o.description,
				hasPreview: typeof o.preview === "string" && o.preview.length > 0,
			})),
		})),
	};
	pi.events.emit(ASK_USER_PROMPT_EVENT, payload);
}

function emitAskUserBlockedEvent(pi: ExtensionAPI, active: boolean): void {
	const payload: AskUserBlockedEventPayload = { active };
	pi.events.emit(ASK_USER_BLOCKED_EVENT, payload);
}

/** Non-interactive host backstop (the reconciler normally strips the tool first). */
function rejectWithoutUi() {
	return buildToolResult(ERROR_NO_UI, { answers: [], cancelled: true, error: "no_ui" });
}

/**
 * Sequential native-dialog walker for RPC hosts; brackets it with the
 * blocked-event pair + terminal bell.
 *
 * The walk is raced against the abort for the same reason the TUI path is: it
 * awaits host dialogs that an aborted turn will never answer. Racing inside the
 * bracket keeps the blocked-event pair balanced. Unlike the TUI path there is no
 * handle to dismiss the host's own dialog, so a stale prompt can outlive the
 * turn — still better than wedging the agent loop behind it forever.
 */
async function runRpcPath(pi: ExtensionAPI, ui: DialogUI, typed: QuestionParams, abort: Promise<typeof ABORTED>) {
	emitAskUserBlockedEvent(pi, true);
	try {
		emitTerminalAttention();
		const result = await Promise.race([runRpcQuestionnaire(ui, typed), abort]);
		if (result === ABORTED) return abortedResult();
		return buildQuestionnaireResponse(result, typed);
	} finally {
		emitAskUserBlockedEvent(pi, false);
	}
}

/** Canonical tool name — single source of truth shared with the reconcile module. */
export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";

const ERROR_NO_UI = "Error: UI not available (running in non-interactive mode)";

const ERROR_NO_CUSTOM_UI =
	"Error: this client cannot render the questionnaire (custom UI is unavailable, e.g. RPC/ACP hosts such as Zed or Paseo). The user never saw the questions — do NOT treat this as a decline. Ask the questions as plain chat text instead, without using this tool.";

const ERROR_SESSION_LOAD_FAILED =
	"Error: the questionnaire UI failed to load — the host's installed dependencies were likely replaced or removed on disk while Pi was running (e.g. a package-manager install touched the store). The user never saw the questions — do NOT treat this as a decline. Ask the questions as plain chat text instead, and tell the user that restoring this tool requires repairing the install if needed and restarting Pi.";

const ERROR_STALE_MODULE_CACHE =
	"Error: the questionnaire UI cannot load — the host's module cache went stale after an earlier failed load (typically dependencies replaced on disk mid-session). This is unrecoverable within the current Pi process. The user never saw the questions — do NOT treat this as a decline. Ask the questions as plain chat text instead, and tell the user to restart Pi to restore this tool.";

/** Standard terminal bell — same byte rpiv-warp exports as OSC_TERMINATOR. */
export const BEL = "\x07";

/**
 * Emit one portable terminal attention signal without touching redirected output.
 * Writes to stdout rather than rpiv-warp's `/dev/tty` transport: the `isTTY` gate
 * both proves an interactive terminal owns the coming wait and keeps the byte out
 * of piped RPC transports (VS Code pendant, Zed) — a `/dev/tty` write would ring
 * even when the questionnaire renders in a remote host's own UI.
 */
function emitTerminalAttention(): void {
	try {
		if (process.stdout.isTTY) process.stdout.write(BEL);
	} catch {
		// Terminal attention is best effort; the questionnaire must still proceed.
	}
}

/** Delay before the background session-graph pre-warm; mirrors rpiv-workflow's /wf prewarm. */
export const PREWARM_DELAY_MS = 2000;

type SessionModule = typeof import("./state/questionnaire-session.js");

type SessionRef = { current: import("./state/questionnaire-session.js").QuestionnaireSession | null };
type OverlayHandleRef = { current: OverlayHandle | undefined };
type DoneRef = { current: ((result: QuestionnaireResult) => void) | undefined };

/** Race sentinel: the turn was aborted before the questionnaire produced a result. */
const ABORTED = Symbol("ask_user_question:aborted");

const ABORTED_MESSAGE =
	"Error: the user interrupted the turn, so the questionnaire was dismissed before it could be answered. The user never saw the questions through — do NOT treat this as a decline.";

/**
 * The result handed to `done()` when an abort dismisses the questionnaire.
 * Built fresh per call: `details` reaches the host and `answers` is mutable, so
 * one shared instance would let a consumer edit every later abort's payload.
 */
function abortedQuestionnaireResult(): QuestionnaireResult {
	return { answers: [], cancelled: true };
}

/** Tool envelope for an aborted questionnaire. */
function abortedResult() {
	return buildToolResult(ABORTED_MESSAGE, abortedQuestionnaireResult());
}

/**
 * A promise that settles when `signal` aborts (immediately if it already has),
 * and never when there is no signal.
 *
 * Pi's abort is cooperative: `agent.abort()` only fires the AbortController, and
 * the agent loop `await`s this tool's promise (`executePreparedToolCall`). The
 * questionnaire settles only when the overlay calls `done()`, so an Esc that
 * reaches the editor instead of the overlay — a collapsed overlay, or one
 * bricked by a sibling `ui.custom` (pi #5129, #7007) — used to leave this
 * promise pending forever. The turn then never finalises: no tool result is
 * written, `isStreaming` stays true, and the TUI sits in "working" with input
 * queued but undeliverable until the session is killed.
 */
function watchAbort(signal: AbortSignal | undefined): {
	promise: Promise<typeof ABORTED>;
	dispose: () => void;
} {
	if (!signal) return { promise: new Promise<typeof ABORTED>(() => {}), dispose: () => {} };
	let remove = () => {};
	const promise = new Promise<typeof ABORTED>((resolve) => {
		if (signal.aborted) {
			resolve(ABORTED);
			return;
		}
		const onAbort = () => resolve(ABORTED);
		signal.addEventListener("abort", onAbort, { once: true });
		remove = () => signal.removeEventListener("abort", onAbort);
	});
	// The executor above ran synchronously, so `remove` is already its final value.
	return { promise, dispose: remove };
}

type SessionLoad =
	| { ok: true; module: SessionModule }
	| { ok: false; error: Extract<QuestionnaireError, "session_load_failed" | "stale_module_cache">; message: string };

/**
 * Lazy-load the ~560ms QuestionnaireSession view/TUI render graph, guarding
 * the two failure shapes of issue #107. Pi's jiti loader registers a module in
 * its graph cache BEFORE evaluating the body and does not evict it when
 * evaluation throws (jiti 2.7.0), so one failed load — e.g. `pnpm install
 * --force` replacing the store entry mid-session — leaves every later import
 * of this specifier resolving to a namespace without the class. That state is
 * unrecoverable in-process (cache-busting specifiers fail jiti resolution);
 * both branches therefore return an LLM-facing envelope that names the restart
 * requirement instead of leaking a bare "not a constructor" TypeError.
 */
export async function loadQuestionnaireSession(): Promise<SessionLoad> {
	let mod: SessionModule;
	try {
		mod = await import("./state/questionnaire-session.js");
	} catch (e) {
		const cause = e instanceof Error ? e.message : String(e);
		return { ok: false, error: "session_load_failed", message: `${ERROR_SESSION_LOAD_FAILED} (cause: ${cause})` };
	}
	if (typeof mod.QuestionnaireSession !== "function") {
		const keys = JSON.stringify(Object.keys(mod));
		return {
			ok: false,
			error: "stale_module_cache",
			message: `${ERROR_STALE_MODULE_CACHE} (resolved namespace keys: ${keys})`,
		};
	}
	return { ok: true, module: mod };
}

/**
 * Register the raw terminal listener that toggles collapse while the overlay is hidden.
 * Returns the remover, or undefined when the key is off / the host has no raw input hook —
 * callers derive `canReopenWhileHidden` from that.
 */
function registerCollapseKeyListener(
	ctx: ExtensionContext,
	collapseKey: string,
	sessionRef: SessionRef,
	overlayHandleRef: OverlayHandleRef,
): (() => void) | undefined {
	if (collapseKey === COLLAPSE_KEY_OFF || typeof ctx.ui.onTerminalInput !== "function") return undefined;
	let hasAnnouncedHide = false;
	return ctx.ui.onTerminalInput((data) => {
		const handle = overlayHandleRef.current;
		if (!handle) return undefined;
		// Only act while the questionnaire is hidden (its handleInput is
		// unreachable) or actually focused. When some other overlay is on
		// top (e.g. `/btw`), leave the keystroke to that overlay instead of
		// toggling the questionnaire from underneath it.
		if (!handle.isHidden() && !handle.isFocused()) return undefined;
		if (!matchesKey(data, collapseKey as Parameters<typeof matchesKey>[1])) return undefined;
		// Kitty-protocol terminals report press, repeat, and release separately.
		// Toggle only on the initial press so a tap does not immediately reopen
		// the overlay and a held key does not toggle it repeatedly.
		if (isKeyRelease(data) || isKeyRepeat(data)) return { consume: true };
		sessionRef.current?.toggleCollapsedExternal();
		if (handle.isHidden() && !hasAnnouncedHide) {
			hasAnnouncedHide = true;
			ctx.ui.notify?.(`ask_user_question hidden — press ${formatKeySpecForDisplay(collapseKey)} to reopen`, "info");
		}
		return { consume: true };
	});
}

/**
 * Build the `ctx.ui.custom` component factory: constructs the session (capturing it in
 * `sessionRef`) and exposes its component. `editInput` keeps its two dynamic imports —
 * they must stay lazy per-invocation.
 */
function makeSessionFactory(config: {
	ctx: ExtensionContext;
	typed: QuestionParams;
	itemsByTab: WrappingSelectItem[][];
	collapseKey: string;
	canReopenWhileHidden: boolean;
	sessionRef: SessionRef;
	doneRef: DoneRef;
	signal: AbortSignal | undefined;
	Session: SessionModule["QuestionnaireSession"];
}) {
	const { ctx, typed, itemsByTab, collapseKey, canReopenWhileHidden, sessionRef, doneRef, signal, Session } = config;
	return (
		tui: TUI,
		theme: Theme,
		keybindings: import("./state/questionnaire-session.js").QuestionnaireSessionConfig["keybindings"],
		done: (result: QuestionnaireResult) => void,
	): import("./state/questionnaire-session.js").QuestionnaireSessionComponent => {
		const session = new Session({
			tui,
			theme,
			params: typed,
			itemsByTab,
			done,
			keybindings,
			editInput: async (value) => {
				try {
					const [{ SettingsManager }, { editWithExternalEditor }] = await Promise.all([
						import("@earendil-works/pi-coding-agent"),
						import("./state/external-editor.js"),
					]);
					const editorCommand = SettingsManager.create(ctx.cwd, undefined, {
						projectTrusted: ctx.isProjectTrusted(),
					}).getExternalEditorCommand();
					if (!editorCommand) throw new Error("No external editor command is configured");
					return await editWithExternalEditor(tui, editorCommand, value);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`${t("editor.failed", "External editor failed")}: ${message}`, "error");
					return undefined;
				}
			},
			collapseKey,
			canReopenWhileHidden,
		});
		sessionRef.current = session;
		doneRef.current = done;
		// The abort may already have fired before pi invoked this factory, during
		// the lazy session-graph import in `execute` — by then `execute` has
		// stopped waiting. Settle the overlay it is still mounting rather than
		// leaving it on screen waiting for a keystroke that an aborted turn will
		// never deliver. Deferred so pi finishes mounting first.
		if (signal?.aborted) queueMicrotask(() => done(abortedQuestionnaireResult()));
		return session.component;
	};
}

/**
 * A TUI questionnaire ALWAYS resolves a QuestionnaireResult (cancel included), so
 * `undefined` uniquely means "host cannot render", never "user declined". RPC builds
 * that predate ctx.mode land here: run the dialog walker when the host has the
 * primitives; otherwise tell the model the user never saw the questions.
 */
async function resolveUndefinedResult(ctx: ExtensionContext, typed: QuestionParams) {
	if (hasDialogUI(ctx.ui)) {
		return buildQuestionnaireResponse(await runRpcQuestionnaire(ctx.ui, typed), typed);
	}
	return buildToolResult(ERROR_NO_CUSTOM_UI, { answers: [], cancelled: true, error: "no_custom_ui" });
}

/**
 * Pre-warm the lazy session graph once startup settles (#107). A graph
 * evaluated while the paths Pi resolved at boot still exist stays in memory
 * for the process lifetime, so later on-disk dependency churn (e.g. `pnpm
 * install --force` replacing the store mid-session) can no longer poison
 * jiti's graph cache. Swallowed failure is safe: the first real call
 * re-imports and surfaces it through loadQuestionnaireSession's structured
 * envelope. unref keeps the timer from holding a non-TUI embedder's process
 * open.
 */
function prewarmSessionGraph(): void {
	const timer = setTimeout(() => void loadQuestionnaireSession().catch(() => undefined), PREWARM_DELAY_MS);
	timer.unref?.();
}

export function buildItemsForQuestion(question: QuestionData): WrappingSelectItem[] {
	const items: WrappingSelectItem[] = question.options.map((o) => ({
		kind: "option",
		label: o.label,
		description: o.description,
	}));
	for (const kind of sentinelsToAppend(question)) {
		items.push({ kind, label: displayLabel(kind) });
	}
	return items;
}

export const DEFAULT_PROMPT_SNIPPET = `Ask the user up to ${MAX_QUESTIONS} structured questions (${MIN_OPTIONS}-${MAX_OPTIONS} options each) when requirements are ambiguous`;
export const DEFAULT_PROMPT_GUIDELINES: string[] = [
	`Reach for ask_user_question when the user's request is underspecified and you cannot proceed without concrete decisions.`,
	`Ask everything in one call (up to ${MAX_QUESTIONS}); don't stack ask_user_question calls back-to-back.`,
	`Users answer through the automatically appended "Type something." row on every question, or press Esc to abandon the questionnaire — never author your own custom-answer option.`,
	`Use multiSelect when several answers can be valid; typed custom text checks its own row and is returned alongside the checked options. Add an option preview (single-select only) when a mockup, snippet, diagram, or config would make a choice clearer.`,
];

/**
 * The TUI questionnaire: mount the overlay through `ctx.ui.custom` and wait for
 * the user, or for the turn to be aborted out from under it.
 */
async function runTuiPath(args: {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	typed: QuestionParams;
	signal: AbortSignal | undefined;
	abort: Promise<typeof ABORTED>;
}) {
	const { pi, ctx, typed, signal, abort } = args;
	const itemsByTab: WrappingSelectItem[][] = typed.questions.map((q) => buildItemsForQuestion(q));

	// Lazy — QuestionnaireSession pulls the ~560ms view/TUI render graph;
	// load it only when the tool runs, not at extension registration.
	const sessionLoad = await loadQuestionnaireSession();
	if (!sessionLoad.ok) {
		return buildToolResult(sessionLoad.message, { answers: [], cancelled: true, error: sessionLoad.error });
	}
	const { QuestionnaireSession } = sessionLoad.module;
	// That import is the widest pre-mount window an Esc can land in.
	if (signal?.aborted) return abortedResult();
	// Resolve the collapse/expand key spec from config. Default is `ctrl+]`; users
	// with non-US layouts (e.g. Latin American, where `]` is shifted) can override
	// via the `collapseKey` config field. `resolveCollapseKey` also accepts the
	// sentinel value `"off"` to disable the shortcut entirely.
	const collapseKey = resolveCollapseKey(loadConfig());

	// Capture the overlay handle so the session can call `setHidden()` when the
	// user toggles collapse, and register a raw terminal input listener for the
	// same key so the toggle still works while the overlay is hidden (pi-tui does
	// not route input to a hidden overlay's `component.handleInput`).
	const sessionRef: SessionRef = { current: null };
	const overlayHandleRef: OverlayHandleRef = { current: undefined };
	const doneRef: DoneRef = { current: undefined };
	const removeOverlayInputListener = registerCollapseKeyListener(ctx, collapseKey, sessionRef, overlayHandleRef);
	// Hiding the overlay is only reversible through the raw listener above, so
	// the session may emit `setHidden` only when it was actually registered;
	// otherwise collapse falls back to the visible one-line row.
	const canReopenWhileHidden = removeOverlayInputListener !== undefined;

	emitAskUserBlockedEvent(pi, true);
	try {
		emitTerminalAttention();
		// Raced, not awaited: a bricked or unfocused overlay can never call
		// `done()`, and the agent loop blocks on this promise, so the abort
		// has to be able to end the wait on its own. See `watchAbort`.
		const result = await Promise.race([
			ctx.ui.custom<QuestionnaireResult>(
				makeSessionFactory({
					ctx,
					typed,
					itemsByTab,
					collapseKey,
					canReopenWhileHidden,
					sessionRef,
					doneRef,
					signal,
					Session: QuestionnaireSession,
				}),
				{
					overlay: true,
					overlayOptions: {
						anchor: "bottom-center",
						width: "100%",
						maxHeight: "100%",
						margin: { left: 0, right: 0, bottom: 0 },
					},
					onHandle: (handle) => {
						overlayHandleRef.current = handle;
						sessionRef.current?.setOverlayHandle(handle);
					},
				},
			),
			abort,
		]);

		if (result === ABORTED) {
			// Settling through `done` is what makes pi unmount the overlay and
			// resolve its own promise; `hide()` is the fallback for an abort
			// that beat the factory, where there is no `done` to call yet.
			if (doneRef.current) doneRef.current(abortedQuestionnaireResult());
			else overlayHandleRef.current?.hide();
			return abortedResult();
		}

		if (result === undefined) {
			return resolveUndefinedResult(ctx, typed);
		}

		return buildQuestionnaireResponse(result, typed);
	} finally {
		removeOverlayInputListener?.();
		emitAskUserBlockedEvent(pi, false);
	}
}

export const DEFAULT_TOOL_DESCRIPTION = `Ask the user one or more structured questions during execution — preferences, requirements, ambiguities, implementation or direction decisions.

Each question takes ${MIN_OPTIONS}-${MAX_OPTIONS} options; each needs a label (1-5 words) and a description of the choice or its trade-offs. Users answer through the automatically appended "Type something." row on every question, or press Esc to abandon the questionnaire, so do not author your own "Other" option — one is dropped rather than shown twice.

- multiSelect: true allows selecting multiple options; the "Type something." row is available there too — typing into it checks that row and its text comes back alongside the checked options, not instead of them.
- To recommend an option, put it first and append "(Recommended)" to its label.
- \`preview\` (single-select only): optional per-option markdown, rendered in a monospace box (multi-line ok), for artifacts the user must compare — ASCII mockups, code snippets, diagram variations, configs. Any option setting it switches the UI to a side-by-side layout (options left, preview right); the "Type something." row stays available there and expands to full width while typing. Skip previews when labels and descriptions suffice.`;

export function registerAskUserQuestionTool(pi: ExtensionAPI): void {
	const guidance = validateGuidanceFields(loadConfig().guidance);
	pi.registerTool({
		name: ASK_USER_QUESTION_TOOL_NAME,
		label: "Ask User Question",
		description: guidance.description ?? DEFAULT_TOOL_DESCRIPTION,
		promptSnippet: guidance.promptSnippet ?? DEFAULT_PROMPT_SNIPPET,
		promptGuidelines: guidance.promptGuidelines ?? DEFAULT_PROMPT_GUIDELINES,
		parameters: QuestionParamsSchema,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const incoming = params as unknown as QuestionParams;
			if (!ctx.hasUI) return rejectWithoutUi();
			if (signal?.aborted) return abortedResult();

			// Validate the caller's original input, then reconcile it with this
			// dialog's own affordances. Order matters: the option floor and the
			// duplicate-label check must judge what the caller actually sent, so
			// normalization can never turn a valid call into a rejected one.
			const validation = validateQuestionnaire(incoming);
			if (!validation.ok) {
				return buildToolResult(validation.message, {
					answers: [],
					cancelled: true,
					error: validation.error,
				});
			}
			const typed = normalizeQuestionnaire(incoming);

			// Emit event for external listeners (e.g., notification plugins)
			emitAskUserPromptEvent(pi, typed);

			// RPC hosts (VSCode pendant, ACP clients like Zed/Paseo — issue #78):
			// ui.custom() cannot render there, but the select/input dialog
			// sub-protocol works. Hosts that advertise ctx.mode (pi ≥0.79) route to
			// the sequential dialog walker up front, skipping the TUI render-graph
			// import entirely; RPC builds that predate ctx.mode are caught by
			// `resolveUndefinedResult` inside the TUI path. See ./rpc-fallback.ts.
			const abortWatch = watchAbort(signal);
			try {
				if ((ctx as { mode?: string }).mode === "rpc" && hasDialogUI(ctx.ui)) {
					return await runRpcPath(pi, ctx.ui, typed, abortWatch.promise);
				}
				return await runTuiPath({ pi, ctx, typed, signal, abort: abortWatch.promise });
			} finally {
				abortWatch.dispose();
			}
		},
	});

	prewarmSessionGraph();
}

export { buildQuestionnaireResponse, buildToolResult };
